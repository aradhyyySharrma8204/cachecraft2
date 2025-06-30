import React, { useState, useEffect, useRef } from "react";
import { Pie, Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
} from "chart.js";

ChartJS.register(
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title
);

function getResultTag(source) {
  if (source === "cache") return <span className="bg-green-100 text-green-700 px-2 py-1 rounded text-xs font-semibold">Cache</span>;
  if (source === "predicted") return <span className="bg-purple-100 text-purple-700 px-2 py-1 rounded text-xs font-semibold">Predicted</span>;
  if (source === "backend") return <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded text-xs font-semibold">Backend</span>;
  return source;
}

const COLORS = {
  backend: "#3b82f6",
  cache: "#22c55e",
  predicted: "#a21caf",
};

function App() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dashboard, setDashboard] = useState({ cache: [], last_10_hits: [], miss_rate: 0, predictions: [] });
  const [missRateHistory, setMissRateHistory] = useState([]);
  const [sourceDist, setSourceDist] = useState({ backend: 0, cache: 0, predicted: 0 });
  const missRateInterval = useRef();
  const [confidence, setConfidence] = useState(0.6);
  const [confLoading, setConfLoading] = useState(false);
  const [refreshing, setRefreshing] = useState({});
  const [now, setNow] = useState(Date.now());
  const [toasts, setToasts] = useState([]);
  const [user, setUser] = useState("guest");
  const users = ["guest", "alice", "bob", "charlie"];

  // Poll dashboard stats every 2 seconds
  useEffect(() => {
    const fetchDashboard = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:8000/dashboard?user=${user}`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        setDashboard(data);
        // Update miss rate history (for line chart)
        setMissRateHistory((prev) => [
          ...prev.slice(-19),
          { t: Date.now(), v: data.miss_rate }
        ]);
        // Update source distribution (for pie chart)
        const dist = { backend: 0, cache: 0, predicted: 0 };
        data.last_10_hits.forEach(h => {
          if (h.source in dist) dist[h.source]++;
        });
        setSourceDist(dist);
      } catch {}
    };
    fetchDashboard();
    missRateInterval.current = setInterval(fetchDashboard, 2000);
    return () => clearInterval(missRateInterval.current);
  }, [user]);

  // Timer for live expiry countdown
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Toast helper
  const showToast = (msg, type = "info") => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts((prev) => prev.filter(t => t.id !== id)), 3000);
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`http://127.0.0.1:8000/search?query=${encodeURIComponent(query)}&user=${user}`);
      if (!res.ok) throw new Error("Backend error");
      const data = await res.json();
      setResult(data);
      if (data.source === "cache") showToast("Served from cache!", "success");
      else if (data.source === "predicted") showToast("Served from predicted cache!", "info");
      else if (data.source === "fuzzy_cache") showToast("Served from fuzzy cache!", "info");
      else if (data.source === "backend") showToast("Fetched from backend.", "warn");
    } catch (err) {
      setError("Failed to fetch result");
      showToast("Failed to fetch result", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleConfidenceChange = async (e) => {
    const val = parseFloat(e.target.value);
    setConfidence(val);
    setConfLoading(true);
    try {
      await fetch(`http://127.0.0.1:8000/set_confidence?user=${user}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confidence: val })
      });
    } catch {}
    setConfLoading(false);
  };

  const handleRefresh = async (query) => {
    setRefreshing((prev) => ({ ...prev, [query]: true }));
    try {
      await fetch(`http://127.0.0.1:8000/refresh?query=${encodeURIComponent(query)}&user=${user}`, {
        method: "POST"
      });
      showToast("Cache entry refreshed!", "success");
    } catch {
      showToast("Failed to refresh cache entry", "error");
    }
    setTimeout(() => setRefreshing((prev) => ({ ...prev, [query]: false })), 1000);
  };

  const handleExport = async (format) => {
    const url = `http://127.0.0.1:8000/export?format=${format}&user=${user}`;
    const res = await fetch(url);
    if (format === "json") {
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "cachecraft_export.json";
      link.click();
    } else if (format === "csv") {
      const text = await res.text();
      const blob = new Blob([text], { type: "text/csv" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "cachecraft_export.csv";
      link.click();
    }
  };

  // Pie chart for source distribution
  const pieData = {
    labels: ["Backend", "Cache", "Predicted"],
    datasets: [
      {
        data: [sourceDist.backend, sourceDist.cache, sourceDist.predicted],
        backgroundColor: [COLORS.backend, COLORS.cache, COLORS.predicted],
        borderWidth: 1,
      },
    ],
  };

  // Line chart for miss rate
  const lineData = {
    labels: missRateHistory.map((pt) => new Date(pt.t).toLocaleTimeString()),
    datasets: [
      {
        label: "Cache Miss Rate",
        data: missRateHistory.map((pt) => pt.v * 100),
        fill: false,
        borderColor: COLORS.backend,
        backgroundColor: COLORS.backend,
        tension: 0.3,
      },
    ],
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-blue-50">
      {/* Toast notifications */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map(t => (
          <div key={t.id} className={`px-4 py-2 rounded shadow text-white font-semibold transition-all animate-fade-in-down ${
            t.type === "success" ? "bg-green-600" :
            t.type === "error" ? "bg-red-600" :
            t.type === "warn" ? "bg-yellow-600" :
            "bg-blue-600"
          }`}>
            {t.msg}
          </div>
        ))}
      </div>
      {/* Header */}
      <header className="bg-white shadow flex items-center px-8 py-4 mb-2">
        <span className="text-2xl font-extrabold text-blue-700 tracking-tight">CacheCraft</span>
        <span className="ml-4 text-gray-400 font-semibold text-sm">Predictive LLM-Driven Cache Layer</span>
        <div className="ml-auto flex items-center gap-2">
          <label htmlFor="user-select" className="font-semibold text-blue-700 mr-2">User</label>
          <select
            id="user-select"
            className="p-2 rounded border border-blue-200 bg-white text-gray-900 font-semibold shadow"
            value={user}
            onChange={e => setUser(e.target.value)}
          >
            {users.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
      </header>
      <div className="flex max-w-7xl mx-auto">
        {/* Sidebar */}
        <aside className="w-96 bg-white/90 rounded-xl shadow-lg p-6 mr-8 mt-2 mb-4 flex flex-col gap-6 h-[90vh] overflow-y-auto">
          <div>
            <div className="font-bold text-lg mb-2 text-blue-700">Cache Entries</div>
            <ul className="text-xs">
              {dashboard.cache.length === 0 && <li className="text-gray-400">(empty)</li>}
              {dashboard.cache.map((item, i) => {
                // Animate expiry color
                let color = "text-green-600";
                if (item.expires_in <= 15) color = "text-red-600 font-bold";
                else if (item.expires_in <= 60) color = "text-yellow-600 font-semibold";
                return (
                  <li key={i} className="mb-1 flex justify-between items-center gap-2">
                    <span className="truncate max-w-[8rem]">{item.query}</span>
                    <span className="ml-2">{getResultTag(item.source)}</span>
                    <span className={`ml-2 tabular-nums transition-colors duration-500 ${color}`}>{item.expires_in}s</span>
                    <button
                      className="ml-2 px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded text-xs font-semibold transition disabled:opacity-50"
                      onClick={() => handleRefresh(item.query)}
                      disabled={refreshing[item.query]}
                    >
                      {refreshing[item.query] ? <span className="animate-spin inline-block w-3 h-3 border-2 border-blue-700 border-t-transparent rounded-full"></span> : "Refresh"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <div className="font-bold text-lg mb-2 text-purple-700">Predicted Next Queries</div>
            <ul className="text-xs">
              {(!dashboard.predictions || dashboard.predictions.length === 0) && <li className="text-gray-400">(none)</li>}
              {dashboard.predictions && dashboard.predictions.map((pred, i) => (
                <li key={i} className="mb-1 flex justify-between">
                  <span className="truncate max-w-[10rem]">{pred.query}</span>
                  <span className="ml-2 text-purple-700 font-bold">{(pred.confidence * 100).toFixed(0)}%</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="font-bold text-lg mb-2 text-blue-700">Last 10 Hits</div>
            <ul className="text-xs">
              {dashboard.last_10_hits.length === 0 && <li className="text-gray-400">(none)</li>}
              {dashboard.last_10_hits.map((hit, i) => (
                <li key={i} className="mb-1 flex justify-between items-center">
                  <span className="truncate max-w-[10rem]">{hit.query}</span>
                  <span className="ml-2">{getResultTag(hit.source)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-4 mt-2">
            <div>
              <span className="font-semibold">Cache Miss Rate:</span> <span className="text-blue-600 font-bold">{(dashboard.miss_rate * 100).toFixed(1)}%</span>
            </div>
          </div>
          <div className="flex flex-col gap-2 mt-2">
            <label htmlFor="confidence-slider" className="font-semibold text-blue-700">Prediction Confidence Threshold</label>
            <input
              id="confidence-slider"
              type="range"
              min={0.5}
              max={0.95}
              step={0.01}
              value={confidence}
              onChange={handleConfidenceChange}
              disabled={confLoading}
              className="w-full accent-blue-600"
            />
            <div className="text-xs text-gray-600">Prefetch if confidence ≥ <span className="font-bold text-blue-700">{(confidence * 100).toFixed(0)}%</span></div>
          </div>
          <div className="flex gap-2 mt-4">
            <button
              className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold shadow"
              onClick={() => handleExport("json")}
            >
              Export as JSON
            </button>
            <button
              className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-xs font-semibold shadow"
              onClick={() => handleExport("csv")}
            >
              Export as CSV
            </button>
          </div>
        </aside>
        {/* Main */}
        <main className="flex-1 p-8 mt-2">
          <form onSubmit={handleSearch} className="mb-8 flex gap-4 items-center">
            <input
              className="border-2 border-blue-200 focus:border-blue-500 p-3 rounded-lg w-2/3 text-lg shadow-sm outline-none transition"
              placeholder="Search for weather, e.g. 'weather in delhi'..."
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            <button className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold text-lg shadow transition disabled:opacity-50" type="submit" disabled={loading}>Search</button>
          </form>
          {/* Charts below search bar */}
          <div className="flex flex-wrap gap-8 mb-8">
            <div className="bg-white rounded-lg shadow p-4 w-80">
              <div className="font-semibold mb-2 text-blue-700">Source Distribution (Last 10 Hits)</div>
              <Pie data={pieData} options={{ plugins: { legend: { position: 'bottom' } } }} />
            </div>
            <div className="bg-white rounded-lg shadow p-4 flex-1 min-w-[300px]">
              <div className="font-semibold mb-2 text-blue-700">Cache Miss Rate Over Time</div>
              <Line data={lineData} options={{
                plugins: { legend: { display: false } },
                scales: { y: { min: 0, max: 100, ticks: { stepSize: 20 } } },
                elements: { point: { radius: 2 } },
                animation: false,
              }} />
            </div>
          </div>
          {loading && <div className="mb-4 text-blue-600 font-semibold">Loading...</div>}
          {error && <div className="mb-4 text-red-600 font-semibold">{error}</div>}
          {result && (
            <div className="bg-white p-6 rounded-xl shadow-lg flex flex-col gap-2 max-w-xl">
              <div className="font-bold text-xl mb-1">{result.result}</div>
              <div>{getResultTag(result.source)}</div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App; 