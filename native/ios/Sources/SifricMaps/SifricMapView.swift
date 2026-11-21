import CoreLocation
import MapLibre
import SwiftUI

@MainActor
public enum SifricMap {
    public static let styleURL = URL(string: "https://maps.sifric.workers.dev/style.json")!

    public static func makeView(center: CLLocationCoordinate2D = .init(latitude: 7.9, longitude: 80.7),
                                zoom: Double = 7, style: URL? = nil) -> MLNMapView {
        let map = MLNMapView(frame: .zero, styleURL: style ?? styleURL)
        map.setCenter(center, zoomLevel: zoom, animated: false)
        return map
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
