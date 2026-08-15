import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ActivityEvent, ActivityRecord, StartScoutRunRequest } from "@happy/contracts";
import "./styles.css";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:3001/v1/events";

const demoItems = ["Graphics card", "Processor", "Motherboard", "Memory", "Power supply", "Case"];

type Health = {
  status: string;
  mode: "mock" | "local" | "aws";
  browser: "synthetic" | "playwright" | "agentcore";
  extraction: "fixture" | "ollama" | "bedrock";
  persistence: "memory" | "local_disk" | "dynamodb";
};

function demoRequest(activityId: string, count = demoItems.length): StartScoutRunRequest {
  return {
    activityId,
    items: demoItems.slice(0, count).map((name, index) => ({
      itemId: `item-${index + 1}`,
      name,
      specs: { use: "budget gaming PC", preference: "best value" },
      quantity: 1,
      rankingPreset: "best_overall",
      shipToCountry: "SG",
      locale: "en-SG"
    }))
  };
}

function App() {
  const [activity, setActivity] = useState<ActivityRecord>();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string>();
  const [health, setHealth] = useState<Health>();
  const [handoff, setHandoff] = useState<string>();
  const lastSequence = useRef(0);
  const activityId = activity?.id;

  useEffect(() => {
    void fetch(`${apiUrl}/health`).then((response) => response.json())
      .then((value: Health) => setHealth(value))
      .catch(() => setError("Could not read API runtime information."));
  }, []);

  useEffect(() => {
    if (!activityId) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let refreshTimer: number | undefined;

    const refreshActivity = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void fetch(`${apiUrl}/v1/scout-runs/${activityId}`)
          .then((response) => response.json())
          .then((next: ActivityRecord) => setActivity(next))
          .catch(() => setError("Could not refresh the Activity state."));
      }, 80);
    };

    const connect = () => {
      socket = new WebSocket(
        `${wsUrl}?activityId=${encodeURIComponent(activityId)}&afterSequence=${lastSequence.current}`
      );
      socket.onopen = () => setError(undefined);
      socket.onmessage = (message) => {
        const event = JSON.parse(String(message.data)) as ActivityEvent;
        lastSequence.current = Math.max(lastSequence.current, event.sequence);
        setEvents((current) => current.some((candidate) => candidate.eventId === event.eventId)
          ? current : [...current, event]);
        refreshActivity();
      };
      socket.onclose = () => {
        if (!disposed) reconnectTimer = window.setTimeout(connect, 500);
      };
      socket.onerror = () => setError("The event stream disconnected; reconnecting.");
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(refreshTimer);
      socket?.close();
    };
  }, [activityId]);

  const scouts = useMemo(() => activity?.items.flatMap((item) => item.scouts.map((scout) => ({
    ...scout,
    itemName: item.request.name
  }))) ?? [], [activity]);

  const startDemo = async (count: number) => {
    setError(undefined);
    setEvents([]);
    setHandoff(undefined);
    lastSequence.current = 0;
    const id = `demo-${crypto.randomUUID()}`;
    const response = await fetch(`${apiUrl}/v1/scout-runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": id },
      body: JSON.stringify(demoRequest(id, count))
    });
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    setActivity(await response.json() as ActivityRecord);
  };

  const reject = async (itemId: string) => {
    if (!activityId) return;
    const response = await fetch(`${apiUrl}/v1/scout-runs/${activityId}/items/${itemId}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Rejected from the developer harness" })
    });
    if (!response.ok) return setError(await response.text());
    setActivity(await response.json() as ActivityRecord);
  };

  const confirmSelected = async () => {
    if (!activityId || !activity) return;
    const itemIds = activity.items.filter((item) => item.status === "selected").map((item) => item.request.itemId);
    if (itemIds.length === 0) return;
    const response = await fetch(`${apiUrl}/v1/scout-runs/${activityId}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemIds })
    });
    if (!response.ok) return setError(await response.text());
    const next = await response.json() as ActivityRecord;
    setActivity(next);
    if (next.status === "ready_for_closer") {
      const handoffResponse = await fetch(`${apiUrl}/v1/scout-runs/${activityId}/closer-handoff`);
      if (handoffResponse.ok) setHandoff(JSON.stringify(await handoffResponse.json(), null, 2));
    }
  };

  const openLiveView = async (scoutId: string) => {
    const response = await fetch(`${apiUrl}/v1/scouts/${scoutId}/live-view-url`, { method: "POST" });
    if (!response.ok) return setError(await response.text());
    const value = await response.json() as { url: string };
    window.open(value.url, "_blank", "noopener,noreferrer");
  };

  return <main>
    <header>
      <div>
        <span className="brand">Happy</span><span className="eyebrow">Scouts developer harness</span>
        {health && <div className="runtimeBadges">
          <span>{health.mode === "local" ? "LOCAL REAL BROWSER" : health.mode.toUpperCase()}</span>
          <span>{health.browser.toUpperCase()}</span>
          <span>{health.extraction.toUpperCase()}</span>
          <span>{health.persistence.toUpperCase()}</span>
        </div>}
      </div>
      <div className="headerActions">
        <button className="secondary" onClick={() => void startDemo(1)}>Start one-item test</button>
        <button onClick={() => void startDemo(6)}>Start six-item demo</button>
      </div>
    </header>
    {health?.extraction === "fixture" && health.mode === "local" &&
      <p className="warning">Real Chromium is active, but candidate evidence is fixture-generated. This validates browsing and observability, not product analysis.</p>}
    {error && <p className="error">{error}</p>}
    {!activity && <section className="empty">Start the deterministic demo to verify queueing, stages, imagery, comparison, and event replay.</section>}
    {activity && <>
      <section className="summary">
        <div><span>Activity</span><strong>{activity.id}</strong></div>
        <div><span>Status</span><strong>{activity.status}</strong></div>
        <div><span>Scouts</span><strong>{scouts.length}</strong></div>
        <div><span>Events</span><strong>{activity.sequence}</strong></div>
      </section>
      <section className="pipeline">
        {activity.items.map((item) => <div className="pipelineRow" key={item.request.itemId}>
          <strong>{item.request.name}</strong>
          {item.scouts.map((scout) => <span className={`stage stage-${scout.stage}`} key={scout.id}>
            {scout.id.endsWith("-a") ? "A" : "B"}: {scout.stage}
          </span>)}
          <div className="itemActions">
            {item.lowCoverage && <span className="coverage">Low coverage</span>}
            {item.status === "selected" && <button className="small secondary" onClick={() => void reject(item.request.itemId)}>Reject</button>}
          </div>
        </div>)}
      </section>
      {activity.status === "awaiting_confirmation" && <div className="confirmBar">
        <span>Review the selections, then confirm all selected items for Closer.</span>
        <button onClick={() => void confirmSelected()}>Confirm selected items</button>
      </div>}
      <section className="grid">
        {scouts.map((scout) => <article className={`tile tile-${scout.stage}`} key={scout.id}>
          <div className="browserBar"><span />{scout.snapshotKey ? "live snapshot" : "waiting"}</div>
          {scout.snapshotKey
            ? <img src={`${apiUrl}/v1/scouts/${scout.id}/snapshot?v=${encodeURIComponent(scout.snapshotKey)}`} alt={`${scout.id} browser`} />
            : <div className="placeholder">Queued for a browser slot</div>}
          <footer><div><strong>{scout.itemName}</strong><small>{scout.strategy}</small><small>{scout.detail}</small></div><div className="tileActions"><span>{scout.stage}</span>{health?.mode === "local" && <button className="small secondary" onClick={() => void openLiveView(scout.id)}>Expand</button>}</div></footer>
        </article>)}
      </section>
      <section className="events">
        <h2>Latest events</h2>
        {events.slice(-12).reverse().map((event) => <code key={event.eventId}>
          {event.sequence.toString().padStart(3, "0")} {event.type} {event.scoutId ?? event.itemId ?? ""}
        </code>)}
      </section>
      {handoff && <section className="handoff"><h2>Closer handoff</h2><pre>{handoff}</pre></section>}
    </>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
