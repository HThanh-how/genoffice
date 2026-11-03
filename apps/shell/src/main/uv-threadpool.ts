// Imported first by the main entry. libuv's default threadpool has 4 threads, and every async fs
// call in the process (stat, readdir, readFile...) shares it. A few stats stuck on a dead network
// share hold threads until the OS gives up, so give the pool headroom before its first use.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '8'

export {}
