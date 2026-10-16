# Azure infrastructure (Bicep)

Provisions a webhook deployment on Azure Container Apps:

- the Container Apps environment and an app with external ingress (so Telegram
  can reach the webhook); one replica stays active so acknowledged background
  agent runs are not terminated by scale-to-zero
- an Azure Files share mounted at `/data` for durable sessions and schedule
- the coach configuration and secrets as app settings
- scheduled Container Apps Jobs that call `/cron/run` for the seeded reminders

This is the Azure equivalent of [`../gcp/`](../gcp/). See
[../../docs/deployment.md](../../docs/deployment.md) for how webhook mode works.

## Deploy

Build and push your image to a registry the app can pull from (for example Azure
Container Registry), then:

```bash
cp main.parameters.json.example main.parameters.json   # then fill it in
az deployment group create -g YOUR_RG -f main.bicep -p main.parameters.json
```

`main.parameters.json` holds secrets; it is gitignored, keep it private (or use
Key Vault references instead of inline values).

## Notes

- Container Apps Jobs interpret their cron in **UTC**, so adjust the reminder
  cron expressions in `main.bicep` for your timezone. The defaults are 11:00 daily
  and 18:00 Sunday in UTC. Set the app's `timezone` separately for its local clock;
  that setting does not convert the job cron expressions. Account for daylight-saving
  changes where relevant.
- The app must keep running long enough to finish a background agent run after it
  acks the Telegram update. The Bicep keeps one small replica active, which adds
  ongoing compute cost compared with scale-to-zero.
