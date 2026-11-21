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
    private double[] destination;
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
        if (closed) throw new IllegalStateException("Navigation session is closed.");
        if (!Double.isFinite(longitude) || !Double.isFinite(latitude) ||
            longitude < 78 || longitude > 82.5 || latitude < 5 || latitude > 10.5) {
            throw new IllegalArgumentException("Choose a destination in Sri Lanka.");
        }
        if (!"drive".equals(travelMode) && !"walk".equals(travelMode) && !"cycle".equals(travelMode)
            && !"motorcycle".equals(travelMode) && !"tuk".equals(travelMode)) {
            throw new IllegalArgumentException("Choose drive, walk, cycle, motorcycle, or tuk.");
        }
        stop();
        active = true;
        lastFix = Long.MIN_VALUE;
        lastReroute = Long.MIN_VALUE;
        mode = travelMode;
        destination = new double[] {longitude, latitude};
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
        Match match = route.project(lon, lat, progress);
        if (match.away > Math.max(35, location.getAccuracy() * 1.5)) {
            if (++outside >= 3 && (lastReroute == Long.MIN_VALUE || lastFix - lastReroute >= 15000)) {
                lastReroute = lastFix;
                plan(lon, lat, true);
            }
            return;
        }
        outside = 0;
        progress = Math.max(progress, match.along);
        double remaining = route.length - progress;
        if (remaining < 25 && route.distanceToEnd(lon, lat) < 25 && location.getAccuracy() <= 25) {
            stop();
            speak("You have arrived.");
            listener.onArrival();
        } else {
            JSONObject next = null;
            for (Turn turn : route.turns) {
                if (turn.along > progress + 5) {
                    next = turn.maneuver;
                    if (speechReady && turn != spoken && turn.along - progress <= 120 &&
                        !"arrive".equals(next.optString("type"))) {
                        spoken = turn;
                        String turnDirection = next.optString("modifier");
                        speak(turnDirection.equals("uturn") ? "Make a U-turn." :
                            turnDirection.isEmpty() || turnDirection.equals("straight") ? "Continue straight." :
                            "Turn " + turnDirection + ".");
                    }
                    break;
                }
            }
            listener.onProgress(remaining, next);
        }
    }

    public void stop() {
        generation++;
        active = false;
        planning = false;
        route = null;
        progress = 0;
        outside = 0;
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
        planning = true;
        requests.execute(() -> {
            try {
                JSONObject request = new JSONObject()
                    .put("mode", travelMode)
                    .put("coordinates", new JSONArray().put(point(lon, lat)).put(point(target[0], target[1])));
                JSONObject data = client.route(request).getJSONArray("routes").getJSONObject(0);
                Route newRoute = new Route(data);
                main.post(() -> {
                    if (attempt != generation) return;
                    route = newRoute;
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

    private static double lonScale(double latitude) {
        return METERS_PER_DEGREE * Math.cos(Math.toRadians(latitude));
    }

    private static final class Match {
        final double along, away;
        Match(double along, double away) { this.along = along; this.away = away; }
    }

    private static final class Turn {
        final double along;
        final JSONObject maneuver;
        Turn(double along, JSONObject maneuver) { this.along = along; this.maneuver = maneuver; }
    }

    private static final class Route {
        final double[] longitude, latitude, starts, lengths, dx, dy;
        final List<Turn> turns = new ArrayList<>();
        final double length;

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
            double along = 0;
            JSONArray legs = data.getJSONArray("legs");
            for (int i = 0; i < legs.length(); i++) {
                JSONArray steps = legs.getJSONObject(i).getJSONArray("steps");
                for (int j = 0; j < steps.length(); j++) {
                    JSONObject maneuver = steps.getJSONObject(j).getJSONObject("maneuver");
                    if ("depart".equals(maneuver.optString("type"))) continue;
                    JSONArray point = maneuver.getJSONArray("location");
                    along = Math.max(along, project(point.getDouble(0), point.getDouble(1), along).along);
                    turns.add(new Turn(along, maneuver));
                }
            }
        }

        double distanceToEnd(double lon, double lat) {
            int end = longitude.length - 1;
            return Math.hypot((longitude[end] - lon) * lonScale(lat), (latitude[end] - lat) * METERS_PER_DEGREE);
        }

        Match project(double lon, double lat, double reference) {
            double cost = Double.POSITIVE_INFINITY, bestAlong = 0, bestAway = cost;
            for (int i = 0; i < lengths.length; i++) {
                if (lengths[i] == 0) continue;
                double x = (lon - longitude[i]) * lonScale(latitude[i]);
                double y = (lat - latitude[i]) * METERS_PER_DEGREE;
                double t = Math.max(0, Math.min(1, (x * dx[i] + y * dy[i]) / (lengths[i] * lengths[i])));
                double away = Math.hypot(x - t * dx[i], y - t * dy[i]);
                double along = starts[i] + t * lengths[i];
                double candidate = away + Math.min(25, Math.abs(along - reference) / 200);
                if (candidate < cost) {
                    cost = candidate;
                    bestAlong = along;
                    bestAway = away;
                }
            }
            return new Match(bestAlong, bestAway);
        }
    }
}
