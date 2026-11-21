package org.sifric.maps;

import android.net.Uri;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Objects;

/** Private Sifric API client. Invoke methods from a background thread. */
public final class SifricClient {
    public interface CredentialProvider {
        String token() throws IOException;
    }

    public static final class ApiException extends IOException {
        public final int status;

        ApiException(int status, String message) {
            super(message);
            this.status = status;
        }
    }

    private static final String API = "https://maps.sifric.workers.dev/developer/api/v1/";
    private static final int MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
    private final CredentialProvider credentials;

    public SifricClient(CredentialProvider credentials) {
        this.credentials = Objects.requireNonNull(credentials);
    }

    public JSONObject search(String query) throws IOException, JSONException {
        return request("places/search?q=" + Uri.encode(query), null);
    }

    public JSONObject nearby(double longitude, double latitude, int radiusMeters) throws IOException, JSONException {
        return request("places/nearby?lon=" + longitude + "&lat=" + latitude + "&radius=" + radiusMeters, null);
    }

    public JSONObject details(long placeId) throws IOException, JSONException {
        return request("places/" + placeId, null);
    }

    public JSONObject route(JSONObject payload) throws IOException, JSONException { return post("routes", payload); }
    public JSONObject matrix(JSONObject payload) throws IOException, JSONException { return post("matrix", payload); }
    public JSONObject matchTrace(JSONObject payload) throws IOException, JSONException { return post("roads/match", payload); }
    public JSONObject optimizeFleet(JSONObject payload) throws IOException, JSONException { return post("optimize", payload); }
    public JSONObject validateAddress(JSONObject payload) throws IOException, JSONException { return post("address/validate", payload); }

    private JSONObject post(String path, JSONObject payload) throws IOException, JSONException {
        return request(path, Objects.requireNonNull(payload));
    }

    private JSONObject request(String path, JSONObject payload) throws IOException, JSONException {
        String token = credentials.token();
        if (token == null || !token.matches("[A-Za-z0-9_-]{43,128}")) throw new IOException("Sifric developer access is required.");
        HttpURLConnection connection = (HttpURLConnection) new URL(API + path).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(60000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (payload != null) {
                byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST");
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream stream = connection.getOutputStream()) {
                    stream.write(bytes);
                }
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                String message = "Sifric API returned HTTP " + status;
                try {
                    message = new JSONObject(read(connection.getErrorStream())).optString("error", message);
                } catch (JSONException ignored) {
                    // Gateways can return a plain-text error.
                }
                throw new ApiException(status, message);
            }
            return new JSONObject(read(connection.getInputStream()));
        } finally {
            connection.disconnect();
        }
    }

    private static String read(InputStream input) throws IOException {
        if (input == null) return "";
        try (InputStream stream = input; ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[8192];
            for (int length; (length = stream.read(chunk)) != -1;) {
                if (bytes.size() + length > MAX_RESPONSE_BYTES) throw new IOException("Sifric response exceeds the limit.");
                bytes.write(chunk, 0, length);
            }
            return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
