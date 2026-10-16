const aliases = new Map([
  ["db press", "DB Bench Press"],
  ["db bench press", "DB Bench Press"],
  ["hill climbs", "Hill Run"],
  ["hill climb", "Hill Run"],
  ["hill run", "Hill Run"],
  ["cable lat raise", "Cable Lateral Raise"],
  ["cable lateral raise", "Cable Lateral Raise"],
  ["deadlifts", "Deadlift"],
]);

export function canonicalExerciseName(name) {
  const value = String(name ?? "")
    .trim()
    .replace(/\s+/g, " ");
  return aliases.get(value.toLowerCase()) ?? value;
}
