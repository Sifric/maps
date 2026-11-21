package org.sifric.maps;

import android.content.Intent;
import android.net.Uri;

/** Share HTTPS map links or dispatch an incoming link to app UI. */
public final class SifricMapsUrls {
    private static final String HOST = "maps.sifric.workers.dev";
    private SifricMapsUrls() {}

    public static Uri search(String query) {
        return base("developer", "").appendQueryParameter("q", query).build();
    }

    public static Uri pin(double longitude, double latitude, double zoom) {
        point(longitude, latitude);
        if (zoom < 0 || zoom > 20 || !Double.isFinite(zoom)) throw new IllegalArgumentException("Invalid zoom.");
        return base("developer", "embed", "").appendQueryParameter("lon", Double.toString(longitude))
            .appendQueryParameter("lat", Double.toString(latitude)).appendQueryParameter("zoom", Double.toString(zoom))
            .appendQueryParameter("pin", "1").build();
    }

    public static Uri directions(double fromLon, double fromLat, double toLon, double toLat, String mode) {
        point(fromLon, fromLat);
        point(toLon, toLat);
        if (!java.util.Arrays.asList("drive", "walk", "cycle", "motorcycle", "tuk").contains(mode)) {
            throw new IllegalArgumentException("Unsupported travel mode.");
        }
        return base("developer", "navigation", "").appendQueryParameter("origin", fromLon + "," + fromLat)
            .appendQueryParameter("destination", toLon + "," + toLat).appendQueryParameter("mode", mode).build();
    }

    public static boolean handles(Uri url) {
        if (url == null || !url.isHierarchical() || !"https".equals(url.getScheme()) ||
            !HOST.equals(url.getHost()) || url.getUserInfo() != null || url.getPort() != -1) return false;
        String path = url.getPath();
        return "/developer/".equals(path) || "/developer/embed/".equals(path) || "/developer/navigation/".equals(path);
    }

    public static Intent open(Uri url) {
        if (!handles(url)) throw new IllegalArgumentException("Not a Sifric Maps link.");
        return new Intent(Intent.ACTION_VIEW, url);
    }

    private static Uri.Builder base(String... segments) {
        return new Uri.Builder().scheme("https").authority(HOST).encodedPath("/" + android.text.TextUtils.join("/", segments));
    }

    private static void point(double lon, double lat) {
        if (!Double.isFinite(lon) || !Double.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
            throw new IllegalArgumentException("Invalid coordinate.");
        }
    }
}
