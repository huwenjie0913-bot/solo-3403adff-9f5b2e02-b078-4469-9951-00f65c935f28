#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""多综织物设计台 —— Flask 后端
所有数据保存在本地 SQLite，计算在浏览器完成；本服务只负责项目与版本的存取。
"""
import os
import json
import sqlite3
import datetime

from flask import Flask, request, jsonify, g, send_file, Response, render_template

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "weaving.db")

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False


# --------------------------------------------------------------------------- #
# 数据库
# --------------------------------------------------------------------------- #
def get_db():
    if "db" not in g:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            data        TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS versions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            label       TEXT NOT NULL,
            data        TEXT NOT NULL,
            created_at  TEXT NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()


def now_iso():
    return datetime.datetime.now().replace(microsecond=0).isoformat()


def row_to_project(r):
    return {
        "id": r["id"],
        "name": r["name"],
        "data": json.loads(r["data"]),
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
    }


# --------------------------------------------------------------------------- #
# 页面
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/print/<int:project_id>")
def print_page(project_id):
    """已保存项目的独立可打印工艺单页面。"""
    return render_template("print.html", project_id=project_id)


# --------------------------------------------------------------------------- #
# 项目 API
# --------------------------------------------------------------------------- #
@app.get("/api/projects")
def list_projects():
    rows = get_db().execute(
        "SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/projects")
def create_project():
    body = request.get_json(force=True)
    name = (body.get("name") or "未命名织物").strip()
    data = body.get("data") or {}
    ts = now_iso()
    db = get_db()
    cur = db.execute(
        "INSERT INTO projects(name, data, created_at, updated_at) VALUES(?,?,?,?)",
        (name, json.dumps(data, ensure_ascii=False), ts, ts),
    )
    db.commit()
    return jsonify({"id": cur.lastrowid, "name": name, "created_at": ts, "updated_at": ts})


@app.get("/api/projects/<int:pid>")
def get_project(pid):
    r = get_db().execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if r is None:
        return jsonify({"error": "项目不存在"}), 404
    return jsonify(row_to_project(r))


@app.put("/api/projects/<int:pid>")
def update_project(pid):
    body = request.get_json(force=True)
    name = (body.get("name") or "未命名织物").strip()
    data = body.get("data") or {}
    ts = now_iso()
    db = get_db()
    cur = db.execute(
        "UPDATE projects SET name=?, data=?, updated_at=? WHERE id=?",
        (name, json.dumps(data, ensure_ascii=False), ts, pid),
    )
    db.commit()
    if cur.rowcount == 0:
        return jsonify({"error": "项目不存在"}), 404
    return jsonify({"id": pid, "name": name, "updated_at": ts})


@app.delete("/api/projects/<int:pid>")
def delete_project(pid):
    db = get_db()
    db.execute("DELETE FROM projects WHERE id=?", (pid,))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# 版本 API（每个版本保存完整草稿快照，可用于并排比较）
# --------------------------------------------------------------------------- #
@app.get("/api/projects/<int:pid>/versions")
def list_versions(pid):
    rows = get_db().execute(
        "SELECT id, project_id, label, created_at FROM versions "
        "WHERE project_id=? ORDER BY id DESC",
        (pid,),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/projects/<int:pid>/versions")
def create_version(pid):
    body = request.get_json(force=True)
    label = (body.get("label") or "").strip() or ("版本 " + now_iso()[5:16].replace("T", " "))
    # 以当前项目数据作为版本快照，也允许显式传入 data
    if body.get("data") is not None:
        data = body["data"]
    else:
        r = get_db().execute("SELECT data FROM projects WHERE id=?", (pid,)).fetchone()
        if r is None:
            return jsonify({"error": "项目不存在"}), 404
        data = json.loads(r["data"])
    ts = now_iso()
    db = get_db()
    cur = db.execute(
        "INSERT INTO versions(project_id, label, data, created_at) VALUES(?,?,?,?)",
        (pid, label, json.dumps(data, ensure_ascii=False), ts),
    )
    db.execute("UPDATE projects SET updated_at=? WHERE id=?", (ts, pid))
    db.commit()
    return jsonify({"id": cur.lastrowid, "label": label, "created_at": ts})


@app.get("/api/versions/<int:vid>")
def get_version(vid):
    r = get_db().execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    if r is None:
        return jsonify({"error": "版本不存在"}), 404
    return jsonify(
        {
            "id": r["id"],
            "project_id": r["project_id"],
            "label": r["label"],
            "data": json.loads(r["data"]),
            "created_at": r["created_at"],
        }
    )


@app.delete("/api/versions/<int:vid>")
def delete_version(vid):
    db = get_db()
    db.execute("DELETE FROM versions WHERE id=?", (vid,))
    db.commit()
    return jsonify({"ok": True})


# --------------------------------------------------------------------------- #
# WIF 导入导出也支持走文件下载（主要导出在前端生成，这里仅做下载通道辅助）
# --------------------------------------------------------------------------- #
@app.post("/api/wif/validate")
def wif_validate():
    """仅做轻量检查：是否包含 WIF 标记，便于前端统一报错。"""
    body = request.get_json(force=True)
    text = body.get("text", "")
    ok = "WIF" in text and ("[THREADING]" in text or "[LIFT PLAN]" in text)
    return jsonify({"ok": bool(ok)})


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=False)
