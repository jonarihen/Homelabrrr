// The name a cloned role starts with: `<name> (copy)`, stepping on to
// `(copy 2)`, `(copy 3)`… past the names already in use. The backend applies the
// same rule when POST /admin/roles/:id/clone isn't sent a name, and still
// catches the duplicate if another admin takes the name first.
export function defaultCloneName(sourceName, existingNames = []) {
  const taken = new Set(existingNames);
  let candidate = `${sourceName} (copy)`;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${sourceName} (copy ${n})`;
    n += 1;
  }
  return candidate;
}
