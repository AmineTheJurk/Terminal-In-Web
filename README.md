# Terminal-In-Web

A web-hosted *real* Linux terminal with a retro CRT interface.

This repository contains a minimal prototype (server + client) that runs a real shell inside the running container and exposes it over WebSocket to a browser-based terminal (xterm.js). The browser UI is intended to be rendered inside the CRT image you provided — replace assets/screen.png with your image and adjust CSS to align the terminal to the "matrix" area.

Security and hosting notes

- This project spawns real shells inside the container. Running this publicly is extremely dangerous. Use only for admin-only, private deployments, or in strongly sandboxed environments.
- Recommended deployment on Render: create a private service, set an ADMIN_TOKEN environment variable, and limit incoming access (or use Render Teams / Private services).
- The server expects ADMIN_TOKEN to be set. The client must supply the token as ?token=YOUR_TOKEN on the page or the WS connection will be rejected.

Quick start (local with Docker)

1. Build the image:
   docker build -t terminal-in-web .
2. Run container:
   docker run -p 3000:3000 -e ADMIN_TOKEN=changeme terminal-in-web
3. Open http://localhost:3000/?token=changeme

Deploy to Render

- Use the Dockerfile in this repo and set the environment variable ADMIN_TOKEN in Render's dashboard.
- Consider using a private service or restricting access by IP or auth layer.

Files included

- server/index.js — Node/Express server + WebSocket + node-pty
- client/index.html — Browser UI with xterm.js overlayed on assets/screen.png
- Dockerfile — Builds the Node image
- package.json — minimal dependencies
- .gitignore
- README.md (this file)

Replace assets/screen.png with your CRT image to use it as the UI background. Edit client/styles.css if you need to tweak the terminal positioning.
