package org.sifric.maps;

import android.content.Context;
import android.os.Bundle;
import android.util.AttributeSet;
import android.widget.FrameLayout;

import org.maplibre.android.MapLibre;
import org.maplibre.android.annotations.Marker;
import org.maplibre.android.annotations.MarkerOptions;
import org.maplibre.android.camera.CameraUpdateFactory;
import org.maplibre.android.geometry.LatLng;
import org.maplibre.android.maps.MapLibreMap;
import org.maplibre.android.maps.MapView;
import org.maplibre.android.maps.OnMapReadyCallback;
import org.maplibre.android.maps.Style;

/** A native MapLibre view with the Sifric basemap. Forward the host lifecycle to this view. */
public final class SifricMapView extends FrameLayout {
    public static final String STYLE_URL = "https://maps.sifric.workers.dev/style.json";
    private final MapView mapView;

    public SifricMapView(Context context) {
        this(context, null);
    }

    public SifricMapView(Context context, AttributeSet attributes) {
        super(context, attributes);
        MapLibre.getInstance(context);
        mapView = new MapView(context);
        addView(mapView, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
    }

    public void onCreate(Bundle state) { mapView.onCreate(state); }
    public void onStart() { mapView.onStart(); }
    public void onResume() { mapView.onResume(); }
    public void onPause() { mapView.onPause(); }
    public void onStop() { mapView.onStop(); }
    public void onLowMemory() { mapView.onLowMemory(); }
    public void onSaveInstanceState(Bundle state) { mapView.onSaveInstanceState(state); }
    public void onDestroy() { mapView.onDestroy(); }

    public void load(OnMapReadyCallback callback) {
        mapView.getMapAsync(map -> map.setStyle(new Style.Builder().fromUri(STYLE_URL), style -> {
            if (map.getCameraPosition().zoom < 1) {
                map.moveCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(7.9, 80.7), 7));
            }
            callback.onMapReady(map);
        }));
    }

    public static Marker addPin(MapLibreMap map, double longitude, double latitude, String title) {
        return map.addMarker(new MarkerOptions().position(new LatLng(latitude, longitude)).title(title));
    }
}
