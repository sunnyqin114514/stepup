/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#FBF1EC",
          100: "#F6E0D6",
          200: "#ECC0AD",
          300: "#E09A7A",
          400: "#E0704A",
          500: "#D95427",
          600: "#C0451F",
          700: "#9A371A",
          800: "#722A15",
          900: "#4D1C0F",
        },
        cream: {
          DEFAULT: "#F7F3EB",
          50: "#FBF9F4",
          100: "#F7F3EB",
          200: "#EDE6D8",
          300: "#E0D6C2",
        },
        accent: {
          400: "#F0C36A",
          500: "#E8B44A",
          600: "#D49A2A",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "PingFang SC",
          "Microsoft YaHei",
          "sans-serif",
        ],
      },
      animation: {
        "fade-in": "fadeIn 0.5s ease-in-out",
        "slide-up": "slideUp 0.4s ease-out",
        "pulse-ring": "pulseRing 2s infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { transform: "translateY(20px)", opacity: "0" },
          "100%": { transform: "translateY(0)", opacity: "1" },
        },
        pulseRing: {
          "0%": { boxShadow: "0 0 0 0 rgba(217,84,39,0.45)" },
          "70%": { boxShadow: "0 0 0 12px rgba(217,84,39,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(217,84,39,0)" },
        },
      },
    },
  },
  plugins: [],
};
