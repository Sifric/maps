# Sifric native SDKs

Download the SDK packages through the authenticated Sifric developer portal.
Both SDKs use the native MapLibre renderer and the Sifric Maps endpoints in
`https://maps.sifric.workers.dev`.

## Android

Download the AAR from `/developer/api/v1/sdk/android/sifric-maps.aar`. Add the AAR
to the application's `libs` directory and add these dependencies to the app:

```gradle
implementation files('libs/sifric-maps.aar')
implementation 'org.maplibre.gl:android-sdk:13.6.1'
```

Use Android API 23 or later. Add `SifricMapView` to the layout, forward the host
Activity or Fragment lifecycle to it, and call `load(map -> ...)` after
`onCreate`. The callback receives the native `MapLibreMap` for styles, camera
gestures, and overlays. Use `SifricMapView.addPin` for a single marker.

Construct `SifricClient` with a credential provider. Its API methods are
blocking, and must run on a background thread. `SifricPlaceSearchView` displays
a native search input and selectable results. `SifricNavigation` receives
`android.location.Location` updates from the host on the main thread. It
requests a route on the first usable fix and emits route, maneuver, progress,
arrival, and error events. Stop or close it when leaving the guidance screen.

Use `SifricClient.route(JSONObject)` with `alternatives: true` to preview
route choices. The navigation `start` overload accepts route preferences,
up to six stops, and a selected route. The listener's optional `onTelemetry` callback exposes
remaining seconds, device speed, and mapped speed limits in km/h when available.

## iOS

Download and unzip the package from `/developer/api/v1/sdk/ios/sifric-maps.zip`.
In Xcode, add the extracted directory as a local Swift package and link the
`SifricMaps` product. Use iOS 15 or later.

The `SifricMapView` SwiftUI view and the `SifricMap.makeView` UIKit factory
return a native MapLibre map. Both accept a style URL and default to the hosted
Sifric basemap. `SifricClient` offers asynchronous API methods, and
`SifricPlaceSearchView` presents selectable results in SwiftUI.
`SifricNavigation` receives `CLLocation` updates delivered by the application
and reports route geometry, upcoming maneuvers, progress, rerouting, and arrival.

Use `SifricClient.routes(coordinates:mode:options:)` and
`SifricRouteOptions` to request route alternatives or optimized stop order.
Pass the selected route, intermediate stops in route order, and preferences to
`SifricNavigation.start(destination:mode:stops:options:initialRoute:)`. Progress
events update `metrics` with remaining seconds, device speed, and posted speed
limit when the route requested `speedLimits` and the current segment is mapped.
Both SDKs retain the unvisited stops when recalculating a route.

## Credentials and device location

Supply credentials at runtime through the SDK provider. Keep shared service
tokens on the developer server and use an authenticated app backend for
consumer-facing deployments. Never place service tokens in a bundled app.
For foreground guidance, the host application requests location permission
and forwards device fixes. The SDKs expose guidance events for the host UI.
The opt-in helpers below support voice and background guidance. Traffic-adjusted durations require an active observation feed.

## Appearance and map overlays

Android `SifricMapView.load(type, theme, callback)` and iOS
`SifricMap.appearance(_:theme:traits:)` offer Default, Satellite, and Terrain
in light, dark, or the device appearance. Camera bounds, markers, polylines
and polygons have convenience methods. The MapLibre native objects also
expose gestures, projection, map and annotation callbacks, custom overlays,
GeoJSON sources, and data-driven style layers.

Map styles are fetched from the hosted Sifric style endpoint, so published road
divider, route-arrow, and label refinements reach SDK maps without embedding a
separate copy of the basemap. Android can get a refreshable URL from
`SifricMapView.appearanceStyleUrl(context, type, theme)`; iOS can switch an
existing view with `SifricMap.applyAppearance(_:to:theme:traits:)`.

The Web SDK accepts `mapType: "default" | "satellite" | "terrain"` and
`theme: "light" | "dark" | "system"` in `createSifricMap` options. It uses the
same hosted appearance styles as the native SDKs.

## Voice guidance and screen lock

Android hosts can enable voice prompts on a `SifricNavigation` instance with
`enableVoice(context)`. For screen-lock guidance, subclass
`SifricNavigationService`, supply the client, listener and foreground
notification, and register the service with `android:exported="false"` and
`android:foregroundServiceType="location"`. Grant precise location before
starting it from visible app UI. Send `longitude`, `latitude`, `mode`, and
optional `voice` Intent extras. Send the service's stop action to end navigation.

iOS hosts use `SifricLocationSession` and retain it during guidance. Set a
location usage description, enable **Location updates** in Background Modes
for screen-lock guidance, call `start(..., background: true)` from the
foreground, and call `stop()` when guidance ends. The helper uses Core Location
and AVSpeechSynthesizer. Both platforms currently speak English prompts.

## Shareable links

Use `SifricMapsUrls` on Android or `SifricMapsURLs` on iOS to create links for
search, a pinned map, and directions. The same HTTPS link opens the authorized
browser view. To open an installed host app directly, register Android App
Links or iOS Universal Links in that app. Publish the authorized association
documents at `/.well-known/assetlinks.json` and
`/.well-known/apple-app-site-association`. The Worker serves operator-verified
documents from `lkmaps/sdk/v1/associations/`; configure the real package,
signing fingerprint, Apple team, and bundle identifiers before publishing.
