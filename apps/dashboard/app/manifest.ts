import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Automated Trading Dashboard",
    short_name: "Trading",
    description: "Live trading dashboard and alerts.",
    start_url: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#000044",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
