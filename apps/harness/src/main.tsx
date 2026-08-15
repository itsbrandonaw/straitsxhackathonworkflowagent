import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ActivityEvent, ActivityRecord, StartScoutRunRequest } from "@happy/contracts";
import "./styles.css";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:3001/v1/events";

const demoItems = ["Graphics card", "Processor", "Motherboard", "Memory", "Power supply", "Case"];

function demoRequest(activityId: string): StartScoutRunRequest {
  return {
    activityId,
    items: demoItems.map((name, index) => ({
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
  const lastSequence = useRef(0);
  const activityId = activity?.id;

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

  const startDemo = async () => {
    setError(undefined);
    setEvents([]);
    lastSequence.current = 0;
    const id = `demo-${crypto.randomUUID()}`;
    const response = await fetch(`${apiUrl}/v1/scout-runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": id },
      body: JSON.stringify(demoRequest(id))
    });
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    setActivity(await response.json() as ActivityRecord);
  };

  return <main>
    <header>
      <div><span className="brand">Happy</span><span className="eyebrow">Scouts developer harness</span></div>
      <button onClick={() => void startDemo()}>Start six-item demo</button>
    </header>
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
        </div>)}
      </section>
      <section className="grid">
        {scouts.map((scout) => <article className={`tile tile-${scout.stage}`} key={scout.id}>
          <div className="browserBar"><span />{scout.snapshotKey ? "live snapshot" : "waiting"}</div>
          {scout.snapshotKey
            ? <img src={`${apiUrl}/v1/scouts/${scout.id}/snapshot?v=${encodeURIComponent(scout.snapshotKey)}`} alt={`${scout.id} browser`} />
            : <div className="placeholder">Queued for a browser slot</div>}
          <footer><div><strong>{scout.itemName}</strong><small>{scout.strategy}</small></div><span>{scout.stage}</span></footer>
        </article>)}
      </section>
      <section className="events">
        <h2>Latest events</h2>
        {events.slice(-12).reverse().map((event) => <code key={event.eventId}>
          {event.sequence.toString().padStart(3, "0")} {event.type} {event.scoutId ?? event.itemId ?? ""}
        </code>)}
      </section>
    </>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
