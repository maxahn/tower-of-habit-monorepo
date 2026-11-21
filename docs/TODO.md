# TODO — Manual / Non-Claude Tasks

## 3.17 — Dead-man's-switch and metrics

- [ ] Sign up for [healthchecks.io](https://healthchecks.io) (free tier covers this)
- [ ] Create a check with grace period = 3× tick interval (default tick is 30s → 90s grace)
- [ ] Copy the ping URL → set `HEALTHCHECKS_URL=https://hc-ping.com/<uuid>` in worker `.env.dev` and production env
- [ ] Configure alert destinations: email + whatever you read on your phone (Pushover, Slack, etc.)
- [ ] Verify: stop the worker → alert fires within the grace period
