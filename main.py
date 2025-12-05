"""
Sample FastAPI backend with health checks and API endpoints.
This is a template for deploying to DigitalOcean.
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime
import os

app = FastAPI(title="FastAPI Backend", version="1.0.0")

# CORS middleware for frontend connections
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Update with specific frontend URL in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health_check():
    """Health check endpoint for monitoring and load balancer"""
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "version": "1.0.0"
    }

@app.get("/api/status")
def api_status():
    """API status endpoint"""
    return {
        "api": "running",
        "environment": os.getenv("NODE_ENV", "production"),
        "uptime": "check health endpoint for details"
    }

@app.get("/api/hello/{name}")
def hello(name: str = "World"):
    """Sample API endpoint"""
    return {
        "message": f"Hello, {name}!",
        "timestamp": datetime.utcnow().isoformat()
    }

@app.post("/api/echo")
def echo(data: dict):
    """Echo endpoint for testing POST requests"""
    return {
        "received": data,
        "timestamp": datetime.utcnow().isoformat()
    }

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 5001))
    host = os.getenv("HOST", "0.0.0.0")
    uvicorn.run(app, host=host, port=port)
