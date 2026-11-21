package org.sifric.maps;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Native search input and a selectable list of Sifric places. */
public final class SifricPlaceSearchView extends LinearLayout {
    public interface OnPlaceSelected {
        void onSelected(JSONObject place);
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<JSONObject> results = new ArrayList<>();
    private final ArrayAdapter<String> labels;
    private final TextView status;
    private ExecutorService requests;
    private Future<?> active;
    private Runnable pending;
    private int revision;

    public SifricPlaceSearchView(Context context, SifricClient client, OnPlaceSelected selection) {
        super(context);
        Objects.requireNonNull(client);
        Objects.requireNonNull(selection);
        setOrientation(VERTICAL);
        EditText search = new EditText(context);
        search.setSingleLine(true);
        search.setHint("Search Sifric Maps");
        addView(search);
        status = new TextView(context);
        status.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setVisibility(GONE);
        addView(status);
        ListView list = new ListView(context);
        labels = new ArrayAdapter<>(context, android.R.layout.simple_list_item_1);
        list.setAdapter(labels);
        list.setOnItemClickListener((parent, view, position, id) -> selection.onSelected(results.get(position)));
        addView(list, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1));
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {
                schedule(client, text.toString().trim());
            }
            @Override public void afterTextChanged(Editable text) {}
        });
    }

    private void message(String text) {
        status.setText(text);
        status.setVisibility(text.isEmpty() ? GONE : VISIBLE);
    }

    private void schedule(SifricClient client, String query) {
        int request = ++revision;
        if (pending != null) main.removeCallbacks(pending);
        if (active != null) active.cancel(true);
        results.clear();
        labels.clear();
        message("");
        if (query.length() < 2 || query.length() > 120) return;
        if (requests == null) requests = Executors.newFixedThreadPool(2);
        pending = () -> active = requests.submit(() -> {
            try {
                JSONArray values = client.search(query).getJSONArray("items");
                main.post(() -> display(request, values));
            } catch (Exception failure) {
                main.post(() -> {
                    if (request == revision) message("Place search is unavailable.");
                });
            }
        });
        main.postDelayed(pending, 220);
    }

    private void display(int request, JSONArray values) {
        if (request != revision) return;
        for (int i = 0; i < values.length(); i++) {
            JSONObject place = values.optJSONObject(i);
            if (place != null) {
                results.add(place);
                String description = place.optString("description");
                labels.add(description.isEmpty() ? place.optString("name") :
                    place.optString("name") + " — " + description);
            }
        }
        message(results.isEmpty() ? "No matching places." : "");
    }

    @Override protected void onDetachedFromWindow() {
        revision++;
        if (pending != null) main.removeCallbacks(pending);
        if (active != null) active.cancel(true);
        if (requests != null) {
            requests.shutdownNow();
            requests = null;
        }
        super.onDetachedFromWindow();
    }
}
