export function displayNameKey(discordName) {
  const nickname = discordName.trim();
  const underscore = nickname.indexOf("_");
  return (underscore === -1 ? nickname : nickname.slice(0, underscore)).trim();
}

export function nameKey(discordName) {
  return displayNameKey(discordName).toLowerCase();
}

export function matchScore(discordName, rosterName) {
  const key = nameKey(discordName);
  const name = rosterName.trim().toLowerCase();
  if (!key || !name) {
    return 0;
  }
  return key === name ? 2 : 0;
}

export function pickPerson(discordName, people) {
  const scored = people
    .map((person, index) => ({ index, score: matchScore(discordName, person.name) }))
    .filter((person) => person.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return { status: "not_found" };
  }

  const best = scored[0].score;
  const winners = scored.filter((person) => person.score === best);
  if (winners.length > 1) {
    return { status: "ambiguous" };
  }
  return { status: "found", index: winners[0].index };
}
