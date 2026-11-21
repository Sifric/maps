import CoreLocation
import MapLibre
import SwiftUI

@MainActor
public enum SifricMap {
    public enum MapType: String { case `default`, satellite, terrain }
    public enum Theme { case light, dark, system }
    public static let styleURL = URL(string: "https://maps.sifric.workers.dev/style.json")!

    public static func appearance(_ type: MapType, theme: Theme = .system,
                                  traits: UITraitCollection = .current) -> URL {
        let dark = theme == .dark || (theme == .system && traits.userInterfaceStyle == .dark)
        return URL(string: "https://maps.sifric.workers.dev/api/v1/native-style.json?type=\(type.rawValue)&theme=\(dark ? "dark" : "light")")!
    }

    public static func makeView(center: CLLocationCoordinate2D = .init(latitude: 7.9, longitude: 80.7),
                                zoom: Double = 7, style: URL? = nil) -> MLNMapView {
        let map = MLNMapView(frame: .zero, styleURL: style ?? appearance(.default))
        map.setCenter(center, zoomLevel: zoom, animated: false)
        return map
    }

    public static func fitBounds(_ bounds: MLNCoordinateBounds, on map: MLNMapView,
                                 padding: UIEdgeInsets = .zero, animated: Bool = true) {
        map.setVisibleCoordinateBounds(bounds, edgePadding: padding, animated: animated)
    }

    @discardableResult
    public static func addPolyline(_ coordinates: [CLLocationCoordinate2D], to map: MLNMapView) -> MLNPolyline? {
        guard coordinates.count >= 2 else { return nil }
        let line = MLNPolyline(coordinates: coordinates, count: UInt(coordinates.count))
        map.addAnnotation(line)
        return line
    }

    @discardableResult
    public static func addPolygon(_ coordinates: [CLLocationCoordinate2D], to map: MLNMapView) -> MLNPolygon? {
        guard coordinates.count >= 3 else { return nil }
        let polygon = MLNPolygon(coordinates: coordinates, count: UInt(coordinates.count))
        map.addAnnotation(polygon)
        return polygon
    }

    @discardableResult
    public static func addPin(to map: MLNMapView, longitude: Double, latitude: Double,
                              title: String? = nil) -> MLNPointAnnotation {
        let annotation = MLNPointAnnotation()
        annotation.coordinate = .init(latitude: latitude, longitude: longitude)
        annotation.title = title
        map.addAnnotation(annotation)
        return annotation
    }
}

public struct SifricMapView: UIViewRepresentable {
    private let center: CLLocationCoordinate2D
    private let zoom: Double
    private let style: URL?
    private let configure: (MLNMapView) -> Void

    public init(center: CLLocationCoordinate2D = .init(latitude: 7.9, longitude: 80.7), zoom: Double = 7,
                style: URL? = nil, configure: @escaping (MLNMapView) -> Void = { _ in }) {
        self.center = center
        self.zoom = zoom
        self.style = style
        self.configure = configure
    }

    public func makeUIView(context: Context) -> MLNMapView {
        let view = SifricMap.makeView(center: center, zoom: zoom, style: style)
        configure(view)
        return view
    }

    public func updateUIView(_ view: MLNMapView, context: Context) {}
}

public struct SifricPlaceSearchView: View {
    let client: SifricClient
    let selection: (SifricPlace) -> Void
    @State private var query = ""
    @State private var results: [SifricPlace] = []
    @State private var message = ""

    public init(client: SifricClient, selection: @escaping (SifricPlace) -> Void) {
        self.client = client
        self.selection = selection
    }

    public var body: some View {
        VStack(alignment: .leading) {
            TextField("Search Sifric Maps", text: $query)
                .textFieldStyle(.roundedBorder)
            if !message.isEmpty { Text(message) }
            List(results) { place in
                Button {
                    selection(place)
                } label: {
                    VStack(alignment: .leading) {
                        Text(place.name)
                        if !place.description.isEmpty {
                            Text(place.description).font(.caption)
                        }
                    }
                }
            }
        }
        .task(id: query) {
            let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
            results = []
            message = ""
            guard (2...120).contains(text.count) else { return }
            do {
                try await Task.sleep(nanoseconds: 220_000_000)
                let places = try await client.search(text)
                try Task.checkCancellation()
                results = places
                if results.isEmpty { message = "No matching places." }
            } catch {
                if !Task.isCancelled { message = "Place search is unavailable." }
            }
        }
    }
}
