/**
 * One D1 batch for everything a page reads. A `Query` is the statements of one read and the parser
 * of their results. `runQueries` puts the statements of all queries into one `DB.batch`, which
 * counts as one D1 query per invocation and one round trip, and hands each query its own slice of
 * the results. A query holds no more statements than the function it replaces, so the batch reads
 * the same rows as the separate reads did.
 */
export interface Query<T> {
  statements: D1PreparedStatement[];
  parse: (results: D1Result[]) => T;
}

export type Parsed<Q extends readonly Query<unknown>[]> = {
  [K in keyof Q]: Q[K] extends Query<infer T> ? T : never;
};

/** Run the queries in one batch. A query without statements is parsed from an empty slice. */
export async function runQueries<const Q extends readonly Query<unknown>[]>(
  db: D1Database,
  queries: Q,
): Promise<Parsed<Q>> {
  const statements = queries.flatMap((query) => query.statements);
  const results = statements.length > 0 ? await db.batch(statements) : [];
  let offset = 0;
  const parsed = queries.map((query) => {
    const slice = results.slice(offset, offset + query.statements.length);
    offset += query.statements.length;
    return query.parse(slice);
  });
  return parsed as Parsed<Q>;
}

/** Run one statement as a one-statement query. */
export function single<T>(
  statement: D1PreparedStatement,
  parse: (result: D1Result) => T,
): Query<T> {
  return {
    statements: [statement],
    parse: ([result]) => parse(result as D1Result),
  };
}
