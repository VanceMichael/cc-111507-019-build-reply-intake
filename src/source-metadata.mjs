function parseJson(bytes) { try { return JSON.parse(bytes.toString()); } catch { return null; } }
export function inspect(bytes) { const value = parseJson(bytes); return { format: 'CMake File API', clients: Object.keys(value?.reply || {}) }; }
