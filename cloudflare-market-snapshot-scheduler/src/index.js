const SYDNEY_TIME_ZONE = "Australia/Sydney";
const WORKFLOW_DISPATCH_URL =
  "https://api.github.com/repos/jmrktch/widgets/actions/workflows/391299788/dispatches";

function sydneyScheduleParts(timestamp) {
  const values = new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));

  return Object.fromEntries(
    values
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
}

function isMarketSlot(timestamp) {
  const { weekday, hour, minute } = sydneyScheduleParts(timestamp);
  if (!new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]).has(weekday)) {
    return false;
  }

  const localHour = Number(hour);
  const localMinute = Number(minute);
  if (localHour === 9) {
    return localMinute === 20 || localMinute === 40;
  }

  return localHour >= 10 && localHour <= 16 && [0, 20, 40].includes(localMinute);
}

async function dispatchWorkflow(env, attempt = 1) {
  const response = await fetch(WORKFLOW_DISPATCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "marketech-focus-snapshot-scheduler",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "master" }),
  });

  if (response.status === 204) {
    return;
  }

  // One retry protects against transient GitHub API failures without risking
  // duplicate collections after a successful dispatch.
  if (attempt === 1 && (response.status === 429 || response.status >= 500)) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return dispatchWorkflow(env, 2);
  }

  // GitHub error payloads are small, structured diagnostics. Record a bounded
  // excerpt to distinguish token, repository, and workflow authorization
  // failures without ever logging the secret itself.
  const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
  throw new Error(
    `GitHub workflow dispatch failed with HTTP ${response.status}: ${detail}`,
  );
}

export default {
  async scheduled(controller, env) {
    const scheduledTime = controller.scheduledTime;
    const slot = sydneyScheduleParts(scheduledTime);

    if (!isMarketSlot(scheduledTime)) {
      console.log(JSON.stringify({ event: "skipped", scheduledTime, slot }));
      return;
    }

    try {
      await dispatchWorkflow(env);
      console.log(JSON.stringify({ event: "dispatched", scheduledTime, slot }));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "dispatch_failed",
          scheduledTime,
          slot,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  },

  fetch() {
    return Response.json({ service: "marketech-focus-snapshot-scheduler", ok: true });
  },
};
