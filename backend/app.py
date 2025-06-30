from fastapi import FastAPI, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict
import time
import threading
import requests
import re
import difflib
from fastapi.responses import JSONResponse, StreamingResponse
import csv

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory cache
CACHE: Dict[str, dict] = {}
CACHE_EXPIRY_SECONDS = 300  # 5 minutes
HIT_LOG = []  # Last 10 hits
PREDICTIONS = []  # Current prediction list
GROQ_API_KEY = "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"
GROQ_MODEL = "mistral-saba-24b"  # Updated to working model
N_HISTORY = 3  # Number of last queries to send for prediction
PREFETCH_CONFIDENCE_THRESHOLD = 0.6

# Analytics counters
API_CALLS_SAVED = 0
TOTAL_BACKEND_CALLS = 0
TOTAL_CACHE_HITS = 0
SIM_BACKEND_LATENCY = 500  # ms
SIM_CACHE_LATENCY = 30     # ms

# Per-user data stores
USER_CACHE = {}
USER_HIT_LOG = {}
USER_PREDICTIONS = {}
USER_ANALYTICS = {}

def normalize_query(query: str) -> str:
    return query.strip().lower()

# Helper: Call Groq LLM for next probable queries
def get_predictions_from_llm(history):
    prompt = f"Given the last user queries: {history}, predict the next 3 likely queries (as a JSON list of objects with 'query' and 'confidence' fields, confidence between 0 and 1). Example: [{{'query': 'weather in gurgaon', 'confidence': 0.83}}, ...]"
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json"
    }
    data = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": "You are a helpful assistant that predicts next user queries for cache prefetching."},
            {"role": "user", "content": prompt}
        ]
    }
    try:
        resp = requests.post("https://api.groq.com/openai/v1/chat/completions", json=data, headers=headers, timeout=10)
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        print("LLM raw response:", content)
        # Extract JSON array from response
        match = re.search(r'\[.*?\]', content, re.DOTALL)
        if match:
            json_str = match.group(0)
            import json as pyjson
            predictions = pyjson.loads(json_str.replace("'", '"'))
            print("LLM parsed predictions:", predictions)
            return predictions
        else:
            print("No JSON array found in LLM response.")
            return []
    except Exception as e:
        print("Groq LLM error:", e)
        return []

# Helper: Prefetch predicted queries in background
def prefetch_predictions(predictions, cache):
    now = int(time.time())
    for pred in predictions:
        q = normalize_query(pred["query"])
        conf = pred.get("confidence", 1.0)
        if conf < PREFETCH_CONFIDENCE_THRESHOLD:
            continue
        if q in cache and (now - cache[q]["timestamp"]) < CACHE_EXPIRY_SECONDS:
            continue  # Already cached
        result = f"Predicted backend result for {pred['query']}"
        cache[q] = {
            "result": result,
            "timestamp": now,
            "expiry": CACHE_EXPIRY_SECONDS,
            "source": "predicted",
            "LLM_Confidence": conf
        }
        print(f"Prefetched predicted query: {q} (confidence: {conf})")

# Helper to get user data dicts
def get_user_data(user):
    if user not in USER_CACHE:
        USER_CACHE[user] = {}
        USER_HIT_LOG[user] = []
        USER_PREDICTIONS[user] = []
        USER_ANALYTICS[user] = {
            'api_calls_saved': 0,
            'total_backend_calls': 0,
            'total_cache_hits': 0
        }
    return USER_CACHE[user], USER_HIT_LOG[user], USER_PREDICTIONS[user], USER_ANALYTICS[user]

@app.get("/search")
def search(query: str, user: str = Query("guest")):
    cache, hit_log, predictions, analytics = get_user_data(user)
    now = int(time.time())
    norm_query = normalize_query(query)
    cache_entry = cache.get(norm_query)
    fuzzy_used = False
    fuzzy_key = None
    if not cache_entry:
        # Try fuzzy match if no exact match
        close_matches = difflib.get_close_matches(norm_query, cache.keys(), n=1, cutoff=0.85)
        if close_matches:
            fuzzy_key = close_matches[0]
            cache_entry = cache[fuzzy_key]
            fuzzy_used = True
    if cache_entry and (now - cache_entry["timestamp"]) < CACHE_EXPIRY_SECONDS:
        if fuzzy_used:
            source = "fuzzy_cache"
            result = cache_entry["result"]
            print(f"Fuzzy cache hit for '{query}' (matched: '{fuzzy_key}')")
            analytics['api_calls_saved'] += 1
            analytics['total_cache_hits'] += 1
        elif cache_entry["source"] == "backend":
            source = "cache"
            result = cache_entry["result"]
            print(f"Cache hit for '{norm_query}' (source: {source})")
            analytics['api_calls_saved'] += 1
            analytics['total_cache_hits'] += 1
        else:
            source = cache_entry["source"]
            result = cache_entry["result"]
            print(f"Cache hit for '{norm_query}' (source: {source})")
            analytics['api_calls_saved'] += 1
            analytics['total_cache_hits'] += 1
    else:
        result = f"Backend result for {query}"
        cache[norm_query] = {
            "result": result,
            "timestamp": now,
            "expiry": CACHE_EXPIRY_SECONDS,
            "source": "backend"
        }
        source = "backend"
        print(f"Cache miss for '{norm_query}', fetched from backend.")
        analytics['total_backend_calls'] += 1
    hit_log.append({"query": query, "source": source, "time": now})
    if len(hit_log) > 10:
        hit_log.pop(0)
    history = [h["query"] for h in hit_log[-N_HISTORY:]]
    def predict_and_prefetch():
        preds = get_predictions_from_llm(history)
        USER_PREDICTIONS[user] = preds
        prefetch_predictions(preds, cache)
    threading.Thread(target=predict_and_prefetch, daemon=True).start()
    return {"result": result, "source": source}

@app.get("/dashboard")
def dashboard(user: str = Query("guest")):
    cache, hit_log, predictions, analytics = get_user_data(user)
    now = int(time.time())
    cache_list = []
    for q, entry in cache.items():
        expires_in = entry["expiry"] - (now - entry["timestamp"])
        if expires_in > 0:
            cache_list.append({
                "query": q,
                "source": entry["source"],
                "expires_in": expires_in
            })
    miss_count = sum(1 for h in hit_log if h["source"] == "backend")
    hit_count = sum(1 for h in hit_log if h["source"] in ("cache", "predicted", "fuzzy_cache"))
    miss_rate = miss_count / (miss_count + hit_count) if (miss_count + hit_count) > 0 else 0.0
    total_calls = analytics['total_backend_calls'] + analytics['total_cache_hits']
    avg_backend = SIM_BACKEND_LATENCY
    avg_cache = SIM_CACHE_LATENCY
    avg_latency_saved = (analytics['api_calls_saved'] * (avg_backend - avg_cache)) / total_calls if total_calls > 0 else 0
    return {
        "cache": cache_list,
        "last_10_hits": hit_log,
        "miss_rate": miss_rate,
        "predictions": predictions,
        "api_calls_saved": analytics['api_calls_saved'],
        "total_backend_calls": analytics['total_backend_calls'],
        "total_cache_hits": analytics['total_cache_hits'],
        "avg_latency_saved": avg_latency_saved
    }

@app.get("/predict")
def get_predictions(user: str = Query("guest")):
    cache, _, predictions, _ = get_user_data(user)
    return {"predictions": predictions}

@app.post("/set_confidence")
async def set_confidence(request: Request, user: str = Query("guest")):
    global PREFETCH_CONFIDENCE_THRESHOLD
    data = await request.json()
    conf = data.get("confidence")
    if isinstance(conf, float) and 0.0 <= conf <= 1.0:
        PREFETCH_CONFIDENCE_THRESHOLD = conf
        print(f"Updated PREFETCH_CONFIDENCE_THRESHOLD to {conf} (user: {user})")
        return JSONResponse({"success": True, "confidence": conf})
    return JSONResponse({"success": False, "error": "Invalid confidence value"}, status_code=400)

@app.post("/refresh")
def refresh(query: str = Query(...), user: str = Query("guest")):
    cache, _, _, _ = get_user_data(user)
    now = int(time.time())
    norm_query = normalize_query(query)
    result = f"Backend result for {query} (refreshed)"
    cache[norm_query] = {
        "result": result,
        "timestamp": now,
        "expiry": CACHE_EXPIRY_SECONDS,
        "source": "backend"
    }
    print(f"Cache forcibly refreshed for '{norm_query}' (user: {user})")
    return {"success": True, "result": result}

@app.get("/export")
def export_dashboard(format: str = "json", user: str = Query("guest")):
    cache, hit_log, predictions, _ = get_user_data(user)
    data = {
        "cache": cache,
        "last_10_hits": hit_log,
        "predictions": predictions
    }
    if format == "csv":
        def generate():
            output = csv.StringIO()
            writer = csv.writer(output)
            writer.writerow(["query", "source", "timestamp", "expiry"])
            for q, entry in cache.items():
                writer.writerow([q, entry["source"], entry["timestamp"], entry["expiry"]])
            yield output.getvalue()
        return StreamingResponse(generate(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=cachecraft_export.csv"})
    return data 