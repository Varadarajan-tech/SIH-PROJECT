# ASHA — AI-Powered Dynamic Mental Health Monitoring & Distress Prediction System

Smart India Hackathon — Problem Statement 26094
Organization: Ministry of Social Justice and Empowerment (MoSJE) / DoSJE
Theme: MedTech / BioTech / HealthTech

## What this is

A working web platform that provides:
- Confidential AI-supported chat for victims/citizens with a Dynamic Distress
  Score (0-100), priority level and escalation routing
- Professional console (mental-health experts): review cases, take over chats,
  report emergencies to officials
- Official dashboard (government): view clinician-submitted emergency reports
- Legal Rights & Guidelines portal (Acts, Rules, Sec. 15A victim rights,
  relief & rehabilitation info) — modelled on dosje.gov.in
- Verified national helpline directory (112, 14566 NHAA, 14416 Tele-MANAS,
  15100 NALSA, 181, 1098, etc.)

## File map

  index.html                 Main portal (role selection, features, helplines)
  citizen-login.html         Citizen/victim OTP login (demo skip available)
  victim-dashboard.html      Citizen AI support chat
  contractor-login.html      Mental-health professional login
  professional-dashboard.html Professional case console
  official-login.html        Government official login
  official-dashboard.html    Official emergency reports view
  legal-support.html         Acts, Rules & Guidelines (searchable)
  helpline.html              Helpline directory
  server.js                  Node.js server (no npm dependencies)
  .env                       Configuration — API keys (NEVER share this file)
  start-server.cmd           Double-click to run the site
  .gitignore                 Keeps secrets out of git

## How to run

1. Double-click  start-server.cmd
   (or run:  D:\SIH\Node\node.exe server.js )
2. Open  http://localhost:3000
3. Check  http://localhost:3000/api/health  to see if the AI is active

## AI chat configuration

The chat uses Groq (free). Put your key in .env:

  GROQ_API_KEY=gsk_...your key...

Model default: openai/gpt-oss-120b  (change with GROQ_MODEL in .env)
Also supported (auto-fallback): XAI_API_KEY (Grok), GEMINI_API_KEY (Gemini).
With no key the chat still works using keyword triage + canned supportive replies.

## SMS OTP (optional)

Without Twilio, use the "Continue to Demo Chat (Skip OTP)" button.
To enable real OTP, set in .env:
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID

## Notes for the demo/presentation

- AI distress scores are decision-support signals, not diagnoses
  (Mental Healthcare Act 2017, Sec. 115 informs the crisis handling).
- Legal content is summarised from public Government of India sources:
  dosje.gov.in (Acts & Rules, NHAA), tribal.nic.in (PoA Act/Rules PDF),
  telemanas.mohfw.gov.in, nalsa.gov.in, PIB press releases.
- Cases are held in memory; restarting the server clears them (by design,
  privacy-first; persistence is a future item).
