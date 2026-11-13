// Node refuses to strip types under node_modules, so npm installations load TypeScript through jiti.
// Checkouts and the Claude plugin cache have no jiti and use Node's own type stripping.
const jiti = await import("jiti").then(({ createJiti }) => createJiti(import.meta.url), () => undefined);

/** Imports a TypeScript module of this package, given relative to this directory. */
export function importTs(relative) {
	const url = new URL(relative, import.meta.url).href;
	return jiti ? jiti.import(url) : import(url);
}
