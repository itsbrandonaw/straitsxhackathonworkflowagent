import { BrowserLiveView } from "bedrock-agentcore/browser/live-view";
import { useCallback, useEffect, useState } from "react";

const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

type LiveConnection = { url: string; expiresAt: string };

function capabilityFromFragment(): string {
  return window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
}

export function LiveViewer() {
  const [connection, setConnection] = useState<LiveConnection>();
  const [message, setMessage] = useState("Connecting to AgentCore Live View…");

  const connect = useCallback(async () => {
    const capability = capabilityFromFragment();
    if (!capability) {
      setConnection(undefined);
      setMessage("This Live View link is incomplete.");
      return;
    }
    try {
      const response = await fetch(`${apiUrl}/v1/live-view/connection`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capability })
      });
      if (!response.ok) throw new Error("unavailable");
      setConnection(await response.json() as LiveConnection);
      setMessage("");
    } catch {
      setConnection(undefined);
      setMessage("Live View is unavailable. Scout discovery is continuing independently.");
    }
  }, []);

  useEffect(() => {
    void connect();
    window.addEventListener("hashchange", connect);
    window.addEventListener("online", connect);
    return () => {
      window.removeEventListener("hashchange", connect);
      window.removeEventListener("online", connect);
    };
  }, [connect]);

  useEffect(() => {
    if (!connection) return;
    const refreshAt = Math.max(1_000, Date.parse(connection.expiresAt) - Date.now() - 30_000);
    const timer = window.setTimeout(() => void connect(), refreshAt);
    return () => window.clearTimeout(timer);
  }, [connection, connect]);

  return <main className="liveViewer" aria-label="Read-only Scout browser Live View">
    {message && <div className="liveViewerStatus">{message}</div>}
    {connection && <div className="liveViewerSurface" aria-hidden="true">
      <BrowserLiveView
        key={connection.url}
        signedUrl={connection.url}
        remoteWidth={1280}
        remoteHeight={720}
      />
    </div>}
  </main>;
}
