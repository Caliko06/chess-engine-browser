// calichess.cc only: the UI speaks the browser's language (Spanish if it starts with "es", else English).
document.documentElement.lang = (navigator.language || "en").toLowerCase().startsWith("es") ? "es" : "en";
