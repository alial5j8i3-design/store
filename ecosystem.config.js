// PM2 cluster mode: Runs multiple worker processes on the same server.
// Important: REDIS_URL must be configured in the environment before startup
// with instances > 1, so that all workers share the same cache (Redis).
// Without REDIS_URL, each worker would use a separate local cache,
// which could lead to data inconsistencies across requests.
module.exports = {
  apps: [{
    name: 'store-app',
    script: 'server.js',
    instances: 1
    exec_mode: 'cluster',
    // Must exceed the 10s hard timer in server.js (SHUTDOWN_TIMEOUT_MS); PM2's
    // default (1.6s) would SIGKILL a worker while it is still closing connections.
    kill_timeout: 12000,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
