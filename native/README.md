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

## Credentials and device location

Supply credentials at runtime through the SDK provider. Keep shared service
tokens on the developer server and use an authenticated app backend for
consumer-facing deployments. Never place service tokens in a bundled app.
For foreground guidance, the host application requests location permission
and forwards device fixes. The SDKs expose guidance events for the host UI.
They do not supply voice instructions, background navigation, or live traffic.
