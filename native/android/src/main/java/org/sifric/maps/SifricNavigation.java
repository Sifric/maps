package org.sifric.maps;

import android.location.Location;
import android.content.Context;
import android.media.AudioAttributes;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Guidance for host-provided Android location fixes. Call on the main thread. */
public final class SifricNavigation implements AutoCloseable {
    public interface Listener {
        void onRoute(JSONObject route, boolean rerouted);
        void onProgress(double remainingMeters, JSONObject nextManeuver);
        default void onTelemetry(double remainingSeconds, Double speedKph, Double speedLimitKph) {}
        void onArrival();
        void onError(String message);
    }

    private static final double METERS_PER_DEGREE = 111195;
    private final SifricClient client;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService requests = Executors.newSingleThreadExecutor();
    private long generation;
    private long lastFix, lastReroute;
    private int outside;
    private boolean active, planning, closed;
    private String mode;
    private String routeOptions;
    private double[] destination;
    private List<double[]> intermediateStops = new ArrayList<>();
    private int visitedStops;
    private Route route;
    private double progress;
    private TextToSpeech speech;
    private boolean speechReady;
    private Turn spoken;

    public SifricNavigation(SifricClient client, Listener listener) {
        this.client = Objects.requireNonNull(client);
        this.listener = Objects.requireNonNull(listener);
    }

    public void enableVoice(Context context) {
        if (closed) throw new IllegalStateException("Navigation session is closed.");
        if (speech != null) return;
        speech = new TextToSpeech(context.getApplicationContext(), status -> main.post(() -> {
            if (speech == null || closed || status != TextToSpeech.SUCCESS) return;
            speechReady = speech.setLanguage(Locale.ENGLISH) >= TextToSpeech.LANG_AVAILABLE;
            speech.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
        }));
    }

    private void speak(String text) {
        if (speechReady) speech.speak(text, TextToSpeech.QUEUE_FLUSH, null, "sifric-maneuver");
    }

    public void start(double longitude, double latitude, String travelMode) {
        start(longitude, latitude, travelMode, null, null);
    }

    /** Uses an optional route preview and preserves route preferences when recalculating. */
    public void start(double longitude, double latitude, String travelMode, JSONObject options, JSONObject initialRoute) {
        start(longitude, latitude, travelMode, Collections.emptyList(), options, initialRoute);
    }

    /** Supply intermediate stops in the chosen order when starting from a preview. */
    public void start(double longitude, double latitude, String travelMode, List<double[]> stops,
                      JSONObject options, JSONObject initialRoute) {
        if (closed) throw new IllegalStateException("Navigation session is closed.");
        if (!validPoint(longitude, latitude)) {
            throw new IllegalArgumentException("Choose a destination in Sri Lanka.");
        }
        if (stops == null || stops.size() > 6) throw new IllegalArgumentException("Choose up to six intermediate stops.");
        List<double[]> waypointCopy = new ArrayList<>();
        for (double[] stop : stops) {
            if (stop == null || stop.length != 2 || !validPoint(stop[0], stop[1])) {
                throw new IllegalArgumentException("Choose intermediate stops in Sri Lanka.");
            }
            waypointCopy.add(stop.clone());
        }
        if (!"drive".equals(travelMode) && !"walk".equals(travelMode) && !"cycle".equals(travelMode)
            && !"motorcycle".equals(travelMode) && !"tuk".equals(travelMode)) {
            throw new IllegalArgumentException("Choose drive, walk, cycle, motorcycle, or tuk.");
        }
        Route initialPlan;
        try {
            initialPlan = initialRoute == null ? null : new Route(initialRoute);
            if (initialPlan != null && initialPlan.stopCount != waypointCopy.size()) {
                throw new JSONException("The route preview must match the intermediate stops.");
            }
        } catch (JSONException error) {
            throw new IllegalArgumentException("Invalid initial route.", error);
        }
        stop();
        active = true;
        lastFix = Long.MIN_VALUE;
        lastReroute = Long.MIN_VALUE;
        mode = travelMode;
        routeOptions = options == null ? "{}" : options.toString();
        destination = new double[] {longitude, latitude};
        intermediateStops = waypointCopy;
        route = initialPlan;
        if (initialPlan != null) listener.onRoute(initialRoute, false);
    }

    public void updateLocation(Location location) {
        if (!active || planning || !location.hasAccuracy() || location.getAccuracy() < 0 ||
            location.getAccuracy() > 70 || location.getTime() <= lastFix) return;
        double lon = location.getLongitude(), lat = location.getLatitude();
        if (!Double.isFinite(lon) || !Double.isFinite(lat)) return;
        lastFix = location.getTime();
        if (route == null) {
            plan(lon, lat, false);
            return;
        }
        Turn nextStop = visitedStops < route.stopCount ? route.stops.get(visitedStops) : null;
        Match match = route.project(lon, lat, progress, nextStop == null ? route.length : nextStop.along);
        if (match.away > Math.max(35, location.getAccuracy() * 1.5)) {
            if (++outside >= 3 && (lastReroute == Long.MIN_VALUE || lastFix - lastReroute >= 15000)) {
                lastReroute = lastFix;
                plan(lon, lat, true);
            }
            return;
        }
        outside = 0;
        progress = Math.max(progress, match.along);
        while (location.getAccuracy() <= 25 && visitedStops < route.stopCount &&
            route.stops.get(visitedStops).isReached(lon, lat, progress)) visitedStops++;
        Turn outstanding = visitedStops < route.stopCount ? route.stops.get(visitedStops) : null;
        double remaining = route.length - progress;
        if (outstanding == null && remaining <= 25 && route.distanceToEnd(lon, lat) <= 25 && location.getAccuracy() <= 25) {
            stop();
            speak("You have arrived.");
            listener.onArrival();
        } else {
            double remainingSeconds = route.duration * remaining / route.length;
            Double speedLimit = route.speedLimit(match.index);
            Double speed = location.hasSpeed() && Float.isFinite(location.getSpeed()) && location.getSpeed() >= 0
                ? location.getSpeed() * 3.6 : null;
            JSONObject next = null;
            for (Turn turn : route.turns) {
                if (turn == outstanding || turn.along > progress + 5) {
                    next = turn.maneuver;
                    if (speechReady && turn != spoken && turn.along - progress <= 120 &&
                        (!"arrive".equals(next.optString("type")) || turn.intermediate)) {
                        spoken = turn;
                        String turnDirection = next.optString("modifier");
                        speak(turn.intermediate ? "Arrive at the next stop." : turnDirection.equals("uturn") ? "Make a U-turn." :
                            turnDirection.isEmpty() || turnDirection.equals("straight") ? "Continue straight." :
                            "Turn " + turnDirection + ".");
                    }
                    break;
                }
            }
            long currentGeneration = generation;
            listener.onProgress(remaining, next);
            if (active && currentGeneration == generation) listener.onTelemetry(remainingSeconds, speed, speedLimit);
        }
    }

    public void stop() {
        generation++;
        active = false;
        planning = false;
        route = null;
        progress = 0;
        outside = 0;
        visitedStops = 0;
        intermediateStops = new ArrayList<>();
        spoken = null;
        if (speech != null) speech.stop();
    }

    @Override public void close() {
        stop();
        closed = true;
        if (speech != null) speech.shutdown();
        speech = null;
        speechReady = false;
        requests.shutdownNow();
    }

    private void plan(double lon, double lat, boolean rerouting) {
        long attempt = generation;
        double[] target = destination;
        String travelMode = mode;
        String options = routeOptions;
        List<double[]> stops = new ArrayList<>(intermediateStops.subList(visitedStops, intermediateStops.size()));
        planning = true;
        requests.execute(() -> {
            try {
                JSONArray coordinates = new JSONArray().put(point(lon, lat));
                for (double[] stop : stops) coordinates.put(point(stop[0], stop[1]));
                JSONObject request = new JSONObject(options)
                    .put("mode", travelMode)
                    .put("coordinates", coordinates.put(point(target[0], target[1])));
                request.remove("waypoints");
                request.remove("alternatives");
                if (stops.isEmpty() || rerouting) request.remove("optimizeWaypointOrder");
                JSONObject result = client.route(request);
                JSONObject data = result.getJSONArray("routes").getJSONObject(0);
                JSONArray order = result.optJSONArray("optimizedIntermediateWaypointIndices");
                List<double[]> ordered = new ArrayList<>();
                if (order == null) ordered.addAll(stops);
                else for (int i = 0; i < order.length(); i++) ordered.add(stops.get(order.getInt(i)));
                Route newRoute = new Route(data);
                if (newRoute.stopCount != ordered.size()) throw new JSONException("Invalid intermediate stop count.");
                main.post(() -> {
                    if (attempt != generation) return;
                    route = newRoute;
                    intermediateStops = ordered;
                    visitedStops = 0;
                    progress = 0;
                    outside = 0;
                    planning = false;
                    listener.onRoute(data, rerouting);
                });
            } catch (Exception failure) {
                main.post(() -> {
                    if (attempt != generation) return;
                    planning = false;
                    if (!rerouting) stop();
                    listener.onError(failure.getMessage());
                });
            }
        });
    }

    private static JSONArray point(double lon, double lat) throws JSONException {
        return new JSONArray().put(lon).put(lat);
    }

    private static boolean validPoint(double lon, double lat) {
        return lon >= 78 && lon <= 82.5 && lat >= 5 && lat <= 10.5;
    }

    private static double lonScale(double latitude) {
        return METERS_PER_DEGREE * Math.cos(Math.toRadians(latitude));
    }

    private static final class Match {
        final double along, away;
        final int index;
        Match(double along, double away, int index) { this.along = along; this.away = away; this.index = index; }
    }

    private static final class Turn {
        final double along;
        final JSONObject maneuver;
        final boolean intermediate;
        final double longitude, latitude;
        Turn(double along, JSONObject maneuver, boolean intermediate, double longitude, double latitude) {
            this.along = along;
            this.maneuver = maneuver;
            this.intermediate = intermediate;
            this.longitude = longitude;
            this.latitude = latitude;
        }

        boolean isReached(double lon, double lat, double progress) {
            return along <= progress + 25 &&
                Math.hypot((longitude - lon) * lonScale(lat), (latitude - lat) * METERS_PER_DEGREE) <= 25;
        }
    }

    private static final class Route {
        final double[] longitude, latitude, starts, lengths, dx, dy;
        final List<Turn> turns = new ArrayList<>();
        final double length, duration;
        final List<JSONObject> limits = new ArrayList<>();
        final List<Turn> stops = new ArrayList<>();
        final int stopCount;

        Route(JSONObject data) throws JSONException {
            JSONArray coordinates = data.getJSONObject("geometry").getJSONArray("coordinates");
            int count = coordinates.length();
            if (count < 2 || count > 40000) throw new JSONException("Invalid route geometry.");
            longitude = new double[count];
            latitude = new double[count];
            starts = new double[count - 1];
            lengths = new double[count - 1];
            dx = new double[count - 1];
            dy = new double[count - 1];
            for (int i = 0; i < count; i++) {
                JSONArray coordinate = coordinates.getJSONArray(i);
                longitude[i] = coordinate.getDouble(0);
                latitude[i] = coordinate.getDouble(1);
            }
            double total = 0;
            for (int i = 0; i < count - 1; i++) {
                dx[i] = (longitude[i + 1] - longitude[i]) * lonScale(latitude[i]);
                dy[i] = (latitude[i + 1] - latitude[i]) * METERS_PER_DEGREE;
                starts[i] = total;
                lengths[i] = Math.hypot(dx[i], dy[i]);
                total += lengths[i];
            }
            if (!(total > 0)) throw new JSONException("The route has no distance.");
            length = total;
            duration = data.optDouble("trafficDuration", data.getDouble("duration"));
            double along = 0;
            JSONArray legs = data.getJSONArray("legs");
            for (int i = 0; i < legs.length(); i++) {
                JSONObject leg = legs.getJSONObject(i);
                JSONArray spans = leg.optJSONArray("speedLimits");
                if (spans != null) {
                    for (int j = 0; j < spans.length(); j++) limits.add(spans.getJSONObject(j));
                }
                JSONArray steps = leg.getJSONArray("steps");
                for (int j = 0; j < steps.length(); j++) {
                    JSONObject maneuver = steps.getJSONObject(j).getJSONObject("maneuver");
                    if ("depart".equals(maneuver.optString("type"))) continue;
                    JSONArray point = maneuver.getJSONArray("location");
                    double lon = point.getDouble(0), lat = point.getDouble(1);
                    int index = maneuver.optInt("geometryIndex", -1);
                    double position = index == count - 1 ? length : index >= 0 && index < starts.length ?
                        starts[index] : project(lon, lat, along, length).along;
                    along = Math.max(along, position);
                    boolean intermediate = i < legs.length() - 1 && "arrive".equals(maneuver.optString("type"));
                    Turn turn = new Turn(along, maneuver, intermediate, lon, lat);
                    if (intermediate) stops.add(turn);
                    turns.add(turn);
                }
            }
            stopCount = stops.size();
        }

        double distanceToEnd(double lon, double lat) {
            int end = longitude.length - 1;
            return Math.hypot((longitude[end] - lon) * lonScale(lat), (latitude[end] - lat) * METERS_PER_DEGREE);
        }

        Double speedLimit(int index) {
            for (JSONObject span : limits) {
                if (span.optInt("startIndex", -1) > index || span.optInt("endIndex", -1) <= index) continue;
                double speed = span.optDouble("speed", Double.NaN);
                if (!(speed > 0) || !Double.isFinite(speed)) return null;
                switch (span.optString("unit")) {
                    case "km/h": return speed;
                    case "mph": return speed * 1.609344;
                    default: return null;
                }
            }
            return null;
        }

        Match project(double lon, double lat, double reference, double end) {
            double cost = Double.POSITIVE_INFINITY, bestAlong = 0, bestAway = cost;
            int bestIndex = 0;
            for (int i = 0; i < lengths.length; i++) {
                if (starts[i] > end) break;
                if (lengths[i] == 0) continue;
                double x = (lon - longitude[i]) * lonScale(latitude[i]);
                double y = (lat - latitude[i]) * METERS_PER_DEGREE;
                double t = Math.max(0, Math.min(Math.min(1, (end - starts[i]) / lengths[i]),
                    (x * dx[i] + y * dy[i]) / (lengths[i] * lengths[i])));
                double away = Math.hypot(x - t * dx[i], y - t * dy[i]);
                double along = starts[i] + t * lengths[i];
                double candidate = away + Math.min(25, Math.abs(along - reference) / 200);
                if (candidate < cost) {
                    cost = candidate;
                    bestAlong = along;
                    bestAway = away;
                    bestIndex = i;
                }
            }
            return new Match(bestAlong, bestAway, bestIndex);
        }
    }
}
