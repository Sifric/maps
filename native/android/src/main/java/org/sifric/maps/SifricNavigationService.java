package org.sifric.maps;

import android.Manifest;
import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import org.json.JSONObject;

/** Extend in the host app and register the subclass as a location foreground service. */
public abstract class SifricNavigationService extends Service implements LocationListener {
    public static final String ACTION_STOP = "org.sifric.maps.STOP_NAVIGATION";
    private final Handler main = new Handler(Looper.getMainLooper());
    private LocationManager locations;
    private SifricNavigation navigation;
    private Runnable arrivalStop;

    protected abstract SifricClient client();
    protected abstract SifricNavigation.Listener listener();
    protected abstract Notification notification();
    protected abstract int notificationId();

    @Override public final int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        releaseNavigation();
        SifricNavigation.Listener events = listener();
        try {
            startForeground(notificationId(), notification());
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                throw new IllegalStateException("Grant precise location before starting navigation.");
            }
            navigation = new SifricNavigation(client(), new SifricNavigation.Listener() {
                private boolean routeReady;
                @Override public void onRoute(JSONObject route, boolean rerouted) {
                    routeReady = true;
                    events.onRoute(route, rerouted);
                }
                @Override public void onProgress(double meters, JSONObject next) { events.onProgress(meters, next); }
                @Override public void onError(String message) {
                    if (!routeReady) stopSelf(startId);
                    events.onError(message);
                }
                @Override public void onArrival() {
                    locations.removeUpdates(SifricNavigationService.this);
                    arrivalStop = () -> stopSelf(startId);
                    main.postDelayed(arrivalStop, 3500);
                    events.onArrival();
                }
            });
            if (intent.getBooleanExtra("voice", true)) navigation.enableVoice(this);
            String mode = intent.getStringExtra("mode");
            navigation.start(intent.getDoubleExtra("longitude", Double.NaN),
                intent.getDoubleExtra("latitude", Double.NaN), mode == null ? "drive" : mode);
            locations = (LocationManager) getSystemService(LOCATION_SERVICE);
            if (!locations.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                throw new IllegalStateException("Enable GPS before starting navigation.");
            }
            locations.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, this, Looper.getMainLooper());
        } catch (RuntimeException failure) {
            releaseNavigation();
            stopSelf(startId);
            events.onError(failure.getMessage());
        }
        return START_NOT_STICKY;
    }

    @Override public final void onLocationChanged(Location location) {
        if (navigation != null) navigation.updateLocation(location);
    }
    @Override public final void onProviderEnabled(String provider) {}
    @Override public final void onProviderDisabled(String provider) {}
    @Override public final void onStatusChanged(String provider, int status, Bundle extras) {}
    @Override public final IBinder onBind(Intent intent) { return null; }

    private void releaseNavigation() {
        if (arrivalStop != null) main.removeCallbacks(arrivalStop);
        arrivalStop = null;
        if (locations != null) locations.removeUpdates(this);
        if (navigation != null) navigation.close();
        navigation = null;
    }

    @Override public void onDestroy() {
        releaseNavigation();
        super.onDestroy();
    }
}
