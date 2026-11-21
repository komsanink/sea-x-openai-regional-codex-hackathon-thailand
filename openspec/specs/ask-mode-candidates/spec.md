# ask-mode-candidates Specification

## Purpose

Ask mode collects group preferences before itinerary design. The candidate service discovers places, enriches them with coordinates and images, and retains enough metadata to interpret the next request. Reference evidence in prep commit `292ba5f` includes `server/agent.mjs` (`runCandidates`, `normalizeSetup`, `matchesPick`, `pickIssues`), `server/photos.mjs`, `server/openai.mjs`, `src/main.js` (`startAsk`, `normQuestions`, `askAct`), `src/ui/place.js`, and `scripts/test-images.mjs`.

## Requirements

### Requirement: Candidates request
`POST /api/plan/candidates` SHALL accept `{ setup }`, split up to three initial web searches among the eligible categories and allow up to two searches in one supplementary call, and end with `done.questions` of at most 3 questions `{ id, kind: 'food'|'sight'|'stay', title, multi: boolean, options }` with at most 6 options each.

Discovery SHALL aim for four distinct places per relevant question and can offer up to six. Restaurants and sights are alternatives even on a one-day trip. On an overnight trip with accommodation left to Bop, the first available question offers named hotels. Food and sightseeing follow in the same survey. A booked stay or a day trip omits the hotel question. The options SHALL respect dates, budget, mobility, food restrictions and expressed interests.

#### Scenario: Independent categories can search at the same time
- **WHEN** the group requests hotel, restaurant and sightseeing suggestions
- **THEN** the initial searches can run concurrently, sharing the initial search and model output allowances. Results are presented in hotel, restaurant, sightseeing order regardless of completion order. A booked stay or day trip excludes the hotel request.
- **AND** a failed category leaves usable sibling results available. A supplementary search can fill the remaining gaps after validating the first results. Canceling the operation cancels its outstanding work. Searching for more choices affects only the active question.

#### Scenario: Too few matching places
- **WHEN** a relevant question starts with fewer than four unique options or is missing
- **THEN** one targeted follow-up can fill the sparse categories together within the remaining search budget. It receives the original constraints and places already returned. A new option from that call requires a source returned by search. A failed or sparse follow-up preserves the usable original choices, without adding placeholders.

#### Scenario: A venue appears more than once
- **WHEN** names differ only by case, punctuation or leading English article, or share a map search name
- **THEN** the traveler sees one card and the available verified source is retained. Different places with a colliding generated ID keep distinct IDs.

#### Scenario: Member with food restrictions
- **WHEN** a member has `avoid` (allergies or foods they do not eat)
- **THEN** the prompt lists each such member with their `avoid` text and asks the model to state for every restaurant whether it has dishes they can eat

### Requirement: Option shape and ids
Each option SHALL be `{ id, name, why, tags (max 4), price?, ll?, photo?, src? }` with an id unique per server run (`c<run>_<slug>`); the server SHALL remember each id with its name, query, coordinates and kind so later `picks` can be resolved, and `src` SHALL be present only for a URL the search returned.

#### Scenario: Avoid by id
- **WHEN** `/api/plan` receives `picks.avoid: ['c3_wat_umong']`
- **THEN** the server resolves it to the remembered name and query

### Requirement: Candidate coordinates
Option coordinates SHALL be geocoded with the same rules as plan stops, in parallel with the photo search, and `ll` SHALL be returned only when valid.

#### Scenario: Geocoded option
- **WHEN** an option's name matches an OSM POI near the model's coordinates
- **THEN** its `ll` is the OSM point

### Requirement: Candidate photos
Each option SHALL get at most one https photo `{ url, credit, page, match }` in confidence order: Wikimedia exact match; og:image of the place's own `photoPage`; og:image of its source page (pass 1, capped at 15 s); Commons files within 300 m (capped at 10 s); then one cheap fast-model page search per option still missing a photo (6 at a time, capped at 60 s), where a hotel photo identifies the named property or branch.

#### Scenario: Small restaurant without Wikimedia
- **WHEN** no Wikimedia or Commons image matches
- **THEN** a page search finds the restaurant's own pages and the first og:image that names the place is used with `match: 'likely'`

#### Scenario: Summary step
- **WHEN** the search ends
- **THEN** the step "ได้ N คำถาม · M ตัวเลือก · มีรูป K" is emitted

### Requirement: Answering in the UI
Once candidates are ready, the UI SHALL present one question at a time in a native modal over the planning map, centered on desktop and attached to the viewport bottom on narrow screens. Focus SHALL move to the question heading on opening and on advancing. Each option can be answered สนใจ, ไม่เอา or ไม่แน่ใจ. The next planning request SHALL send `picks = { must: [full option objects answered สนใจ], avoid: [named references answered ไม่เอา] }`. Skipped questions and uncertain options contribute no picks.

#### Scenario: Choose a hotel before selecting restaurants and sights
- **WHEN** the hotel question is available
- **THEN** the same card grid presents each named property, a matched photo and credit when available, its location, the reason for recommending it, a source link and any known room rate per night. An unknown nightly rate is identified explicitly.
- **AND** the traveler can mark สนใจ on one hotel. Choosing another transfers that answer. The ไม่เอา and ไม่แน่ใจ answers, map preview and search for more options work in the same question. Food and sightseeing retain their multiple selections.

#### Scenario: The group already has accommodation
- **WHEN** the group supplied its booked accommodation or the trip has no overnight stay
- **THEN** Bop continues directly to food and sightseeing choices and omits hotel discovery and its question.

#### Scenario: Skip to auto
- **WHEN** the organizer presses Escape in the ask dialog
- **THEN** planning starts directly with the original setup and the answers collected so far

#### Scenario: Inspect the map between answers
- **WHEN** the organizer chooses ดูแผนที่ while answering
- **THEN** the dialog closes temporarily. The planning rail offers เปิดคำถามอีกครั้ง and ยกเลิก. Reopening restores the current question and its answers. Canceling from the rail returns to the existing trip draft.

#### Scenario: Candidate discovery fails
- **WHEN** the candidate request fails before returning questions
- **THEN** the planning rail offers ลองใหม่, ให้ Bop จัดให้เลย and แก้ข้อมูลทริป. Choosing direct planning retains the trip details and skips candidate discovery.

#### Scenario: Photo badge
- **WHEN** an option photo has `match: 'likely'`
- **THEN** the card shows the badge "รูปจากเว็บ"

### Requirement: Question and option normalization

The candidate handler SHALL validate the setup as for normal planning, omit previous picks from the discovery prompt and localize search using the destination city and country when resolved. It SHALL inspect the first three model questions, drop questions with no named options, and limit the surviving named options to six per question. Unrecognized kinds default to `sight`. The response carries `questions`, elapsed milliseconds and aggregated `usage`.

#### Scenario: Blank question title or repeated option IDs
- **WHEN** the model supplies a blank title, unnamed options or multiple options with the same slug
- **THEN** the server uses a Thai fallback title, drops unnamed options and adds trailing underscores until each generated option ID is unique across that response

#### Scenario: Descriptive metadata
- **WHEN** the model supplies a long name, explanation, price hint and tags
- **THEN** the name is limited to 120 characters, the explanation to 200, and the optional price hint to 240. Longer price text ends at a word boundary with an ellipsis when possible. Up to four nonempty tags of 24 characters each survive. A displayed source requires both a web check and a URL recorded by the search

#### Scenario: Photo metadata and failures
- **WHEN** an option lacks its own confirmed source but the model supplied a public page as a photo hint
- **THEN** the collector can inspect the page for a matched image independently of source verification. The option returns a successful photo or omits it. Research-only queries, aliases, page hints and temporary geocoding inputs are removed from the response

#### Scenario: Official page for a restaurant branch
- **WHEN** the venue’s domain identifies the restaurant and the URL path identifies its branch
- **THEN** a matching page preview can appear in the question as Wikimedia is checked. If the supplied thumbnail fails, the card tries the original image.

### Requirement: Pick continuity and limits

The server SHALL remember each option’s name, query, resolved coordinates and kind in process memory. When normalizing the planning request it SHALL accept up to 15 named must-pick objects and the first 30 avoided entries. Valid coordinates on a submitted must-pick take precedence over remembered coordinates. Must-picks can match by name, query or distance of at most 250 m. Avoided places match by name or remembered query.

#### Scenario: Process restarted between steps
- **WHEN** the organizer supplies a complete must-pick object but the server no longer has its ID in memory
- **THEN** the submitted name and valid coordinates can still be used. Named avoid references retain the rejected place across instances. A legacy bare unknown avoid ID supplies only its string as the fallback name, so durable ID resolution across instances is unavailable

#### Scenario: One option selected twice
- **WHEN** a user repeats the same answer on a candidate card
- **THEN** the UI clears that answer. Skipping a question clears all answers on the current question and preserves earlier answers

#### Scenario: Candidate discovery returns no choices
- **WHEN** the response has no usable questions after normalization
- **THEN** the browser starts itinerary design directly. For older responses containing a flat `candidates` array it first groups options into questions

#### Scenario: Cancelled or replaced request
- **WHEN** another planning operation supersedes candidate discovery
- **THEN** the UI aborts the earlier request and ignores subsequent results from the old request

#### Scenario: A traveler selects an answer on a place card

- **WHEN** the traveler chooses สนใจ, ไม่เอา or ไม่แน่ใจ
- **THEN** that place immediately shows one pressed answer with a checkmark, a green, red or amber fill respectively and a matching card outline. Selecting another answer moves the mark. Selecting the same answer again clears it. Viewing the map and reopening the question preserves the answer.

#### Scenario: Discover more options without leaving a question

- **WHEN** a traveler requests more choices on a food, sight or hotel question
- **THEN** Bop searches the active category using the same trip preferences and excludes places already shown. New options require a corroborating web source and appear in the same question. Existing answers remain available for the plan.
- **AND** while searching, the traveler can inspect the map, advance or start planning. An empty result or error keeps the current options and answers available, and a late response cannot replace the next question.
