"""{{title}}: a FastAPI service."""

from fastapi import FastAPI

app = FastAPI(title="{{title}}")


@app.get("/")
def root() -> dict[str, str]:
    return {"name": "{{title}}", "status": "ok"}


@app.get("/hello/{name}")
def hello(name: str) -> dict[str, str]:
    return {"message": f"Hello, {name}!"}
