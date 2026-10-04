export class IndexMutationTimeout extends Error {
  constructor() {
    super('Index action did not acknowledge completion in time')
    this.name = 'IndexMutationTimeout'
  }
}

/** A timeout is an unknown outcome: callers must not automatically repeat a mutation. */
export function runIndexMutation<T>(request: () => Promise<T>, timeoutMs = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new IndexMutationTimeout()), timeoutMs)
    Promise.resolve()
      .then(request)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
  })
}
