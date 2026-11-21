// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SifricMaps",
    platforms: [.iOS(.v15)],
    products: [.library(name: "SifricMaps", targets: ["SifricMaps"])],
    dependencies: [
        .package(url: "https://github.com/maplibre/maplibre-native-distribution.git", exact: "6.29.0")
    ],
    targets: [
        .target(name: "SifricMaps", dependencies: [
            .product(name: "MapLibre", package: "maplibre-native-distribution")
        ])
    ]
)
