package org.sifric.maps;

import android.content.Context;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.util.AttributeSet;
import android.widget.FrameLayout;

import org.maplibre.android.MapLibre;
import org.maplibre.android.annotations.Marker;
import org.maplibre.android.annotations.MarkerOptions;
import org.maplibre.android.camera.CameraUpdateFactory;
import org.maplibre.android.geometry.LatLng;
import org.maplibre.android.geometry.LatLngBounds;
import org.maplibre.android.annotations.Polyline;
import org.maplibre.android.annotations.PolylineOptions;
import org.maplibre.android.annotations.Polygon;
import org.maplibre.android.annotations.PolygonOptions;
import org.maplibre.android.maps.MapLibreMap;
import org.maplibre.android.maps.MapView;
import org.maplibre.android.maps.OnMapReadyCallback;
import org.maplibre.android.maps.Style;
import java.util.List;

/** A native MapLibre view with the Sifric basemap. Forward the host lifecycle to this view. */
public final class SifricMapView extends FrameLayout {
    public enum MapType { DEFAULT, SATELLITE, TERRAIN }
    public enum Theme { LIGHT, DARK, SYSTEM }
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
        load(MapType.DEFAULT, Theme.SYSTEM, callback);
    }

    public void load(MapType type, Theme theme, OnMapReadyCallback callback) {
        String url = appearanceStyleUrl(getContext(), type, theme);
        mapView.getMapAsync(map -> map.setStyle(new Style.Builder().fromUri(url), style -> {
            if (map.getCameraPosition().zoom < 1) {
                map.moveCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(7.9, 80.7), 7));
            }
            callback.onMapReady(map);
        }));
    }

    /** Returns the live hosted style URL so a host can switch appearance after map creation. */
    public static String appearanceStyleUrl(Context context, MapType type, Theme theme) {
        boolean dark = theme == Theme.DARK || (theme == Theme.SYSTEM &&
            (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES);
        return Uri.parse("https://maps.sifric.workers.dev/api/v1/native-style.json").buildUpon()
            .appendQueryParameter("type", type.name().toLowerCase(java.util.Locale.ROOT))
            .appendQueryParameter("theme", dark ? "dark" : "light").build().toString();
    }

    public static void fitBounds(MapLibreMap map, LatLngBounds bounds, int paddingPixels, boolean animated) {
        org.maplibre.android.camera.CameraUpdate update = CameraUpdateFactory.newLatLngBounds(bounds, paddingPixels);
        if (animated) map.animateCamera(update);
        else map.moveCamera(update);
    }

    public static Polyline addPolyline(MapLibreMap map, List<LatLng> points, int color, float width) {
        return map.addPolyline(new PolylineOptions().addAll(points).color(color).width(width));
    }

    public static Polygon addPolygon(MapLibreMap map, List<LatLng> points, int fillColor, int strokeColor) {
        return map.addPolygon(new PolygonOptions().addAll(points).fillColor(fillColor).strokeColor(strokeColor));
    }

    public static Marker addPin(MapLibreMap map, double longitude, double latitude, String title) {
        return map.addMarker(new MarkerOptions().position(new LatLng(latitude, longitude)).title(title));
    }
}
