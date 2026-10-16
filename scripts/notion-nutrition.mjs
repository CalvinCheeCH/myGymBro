const rounded = (value) => Math.round(value * 10) / 10;
const display = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });

export function summarizeNutrition(date, meals, targets = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new Error("Nutrition summary needs a YYYY-MM-DD date.");
  }
  const sum = (key) =>
    rounded(
      meals.reduce((total, meal) => {
        const value = meal[key];
        return total + (Number.isFinite(value) && value >= 0 ? value : 0);
      }, 0),
    );
  const target = (value) => (Number.isFinite(value) && value > 0 ? value : null);
  return {
    date,
    records: meals.length,
    calories: sum("kcal"),
    protein: sum("protein"),
    calorieTarget: target(targets.calories),
    proteinTarget: target(targets.protein),
    incomplete: meals.some((meal) => !Number.isFinite(meal.kcal) || !Number.isFinite(meal.protein)),
  };
}

export function nutritionCaption(summary) {
  const { date, calories, protein, calorieTarget, proteinTarget } = summary;
  return `${date} · Calories: ${display(calories)}${calorieTarget ? ` / ${display(calorieTarget)}` : " (target not set)"} kcal · Protein: ${display(protein)}${proteinTarget ? ` / ${display(proteinTarget)}` : " (target not set)"} g`;
}
