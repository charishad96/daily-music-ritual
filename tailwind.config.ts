import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#111827",
        mist: "#eef2ff",
        dusk: "#143642",
        rosewater: "#f8e7dc",
        ember: "#d97941",
        pine: "#35524a",
        gold: "#d9a441"
      },
      boxShadow: {
        halo: "0 24px 80px rgba(17, 24, 39, 0.18)"
      },
      backgroundImage: {
        "hero-radial":
          "radial-gradient(circle at top left, rgba(217, 164, 65, 0.24), transparent 34%), radial-gradient(circle at top right, rgba(20, 54, 66, 0.32), transparent 36%), linear-gradient(180deg, #fffdf8 0%, #f8efe7 52%, #eef2ff 100%)"
      }
    }
  },
  plugins: []
};

export default config;
