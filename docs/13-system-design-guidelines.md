# System design guidelines

These are the reference design guidelines for One Tappe and every future project. CLAUDE.md requires them.
Before designing or changing a component, find the matching chapter below. Apply its pattern, or write down why it doesn't apply.
Source: summary of all 28 chapters of https://github.com/liquidslr/system-design-notes (_System Design Interview_ Vol. 1 and 2).

## How to apply these guidelines

1. **Scope first** (chapter 3). Write down the requirements, the scale, the non-functional targets and the assumptions. Estimate QPS and storage (chapter 2) before choosing technology.
2. **Pick the matching pattern.** Use the cross-cutting table at the end. Reuse proven building blocks; don't invent new infrastructure.
3. **The server decides.** Booking, pricing, availability, payment and authorization state live in the database behind the API. Clients and third parties are never authoritative (chapters 4, 25, 26).
4. **Correctness before speed.** Use idempotency keys, database constraints as the final guard, exactly-once as at-least-once plus dedup, and reconciliation against the source of truth (chapters 21, 22, 26, 27).
5. **Design for failure.** Use queues with retry, backoff and a dead-letter queue. Keep external calls out of database transactions. Monitor queue lag and alert on it (chapters 10, 19, 20, 26).
6. **Scale only when the numbers say so.** Start with a stateless tier, one primary database and caches. Shard by the dominant query key only when the estimates require it. No unnecessary microservices (chapters 1, 22).
7. **Record the decision** and the trade-off you accepted in the project's design docs.

---

---

## Part A: Foundations

### 1. Scaling from zero to millions of users

- Start with a single server. Then move the database to its own server (SQL by default; NoSQL for very low latency, unstructured data or huge volume).
- **Vertical scaling** has a hard ceiling and no failover. **Horizontal scaling** is preferred.
- **Load balancer** with a public IP; the web servers sit on private IPs.
- **Database replication**: writes go to the master, reads to the slaves. Gives availability and read scaling, and a slave is promoted if the master fails.
- **Cache tier** (read-through). Points to consider: when to use it, expiry, consistency, a single point of failure, eviction policy (LRU/LFU/FIFO).
- **CDN** for static assets: TTL, cost, fallback, invalidation (API or versioned URLs).
- **Stateless web tier**: session state goes into a shared store (Redis/NoSQL) so any server can serve any request, which enables autoscaling.
- **Multiple data centres** with geoDNS routing. Challenges: traffic redirection, data sync, testing and deployment.
- **Message queue** decouples producers from consumers so each scales independently.
- **Logging, metrics, automation** (CI/CD).
- **Sharding** by a shard key. Problems: resharding (consistent hashing), celebrity/hotspot keys, and joins (denormalise).
- Checklist: stateless web tier, redundancy at every tier, cache aggressively, multiple DCs, CDN for static content, shard the data tier, split tiers into services, monitor and automate.

### 2. Back-of-the-envelope estimation

- Powers of two (KB→PB).
- **Latency numbers**: memory is fast and disk is slow; avoid disk seeks; compression is cheap; cross-region round trips are about 150 ms.
- **Availability nines**: 99% ≈ 3.65 days/yr of downtime, 99.9% ≈ 8.8 h, 99.99% ≈ 52 min, 99.999% ≈ 5 min.
- Method: DAU → QPS (÷ about 10⁵ s/day), peak = 2–5× average, then storage per year.
- Tips: round numbers, write down assumptions, label units.

### 3. The 4-step interview framework

1. **Understand the problem and set the scope** (3–10 min). Ask about features, users, scale, growth and the existing stack.
2. **Propose a high-level design and get buy-in** (10–15 min). Box diagram, APIs, back-of-envelope numbers.
3. **Deep dive** (10–25 min) into the components that are critical or bottlenecks.
4. **Wrap up** (3–5 min). Bottlenecks, error cases, operations/monitoring, the next scale curve.

---

## Part B: Building blocks

### 4. Rate limiter

- **Where it runs**: server side, or as middleware/API gateway. Avoid client side, because the client can't be trusted.
- **Algorithms**:
  - Token bucket: bucket size plus refill rate; allows bursts. Used by Amazon and Stripe.
  - Leaking bucket: FIFO queue drained at a fixed rate, giving smooth output.
  - Fixed window counter: simple, but bursts at window edges can double the limit.
  - Sliding window log: exact, but memory-heavy (stores timestamps).
  - Sliding window counter: current window + previous window × overlap %. A cheap approximation.
- **Storage**: Redis counters (`INCR`/`EXPIRE`).
- **Rules** are kept in config (e.g. Lyft-style YAML) and cached.
- **Response**: HTTP **429** with `X-Ratelimit-Remaining`, `-Limit` and `-Retry-After`. Throttled requests are dropped or queued.
- **Distributed issues**: race conditions (Lua scripts, sorted sets) and sync across limiters (a central Redis). Multi-DC edge deployment.
- Rate limiting can be applied by IP, by user or at layer 3. Clients should use backoff and caching.

### 5. Consistent hashing

- `hash(key) % N` remaps nearly every key when N changes.
- **Hash ring**: servers and keys are placed on the ring; a key goes clockwise to the next server. Adding or removing a server moves only about k/N keys.
- **Virtual nodes** give each server many positions, which evens out load (standard deviation drops as the number of vnodes grows). Weighting is done by vnode count.
- Used by Dynamo, Cassandra, Discord, Akamai and Maglev.

### 6. Key-value store

- **CAP**: only 2 of C, A and P. Partitions are inevitable, so choose **CP** (block writes) or **AP** (accept stale reads).
- **Partitioning** by consistent hashing. **Replication** to the next N distinct servers on the ring, spread across DCs.
- **Quorum** N/W/R: W + R > N gives strong consistency. R=1, W=N gives fast reads; W=1, R=N gives fast writes.
- **Consistency models**: strong, weak, eventual. Dynamo and Cassandra use eventual consistency.
- **Vector clocks** `[server, version]` detect conflicts, and the client reconciles them. Downsides: client complexity and clock growth (trimmed by a threshold).
- **Failure detection**: gossip protocol with heartbeat counters.
- **Temporary failures**: sloppy quorum plus **hinted handoff**.
- **Permanent failures**: anti-entropy with **Merkle trees**, which compare replicas bucket by bucket.
- **Data-centre outage**: multi-DC replication.
- **Write path**: commit log → memtable → SSTable flush.
- **Read path**: memtable → **Bloom filter** → SSTables.

### 7. Unique ID generator

- Options:
  - Multi-master auto-increment (step by k): hard to scale across DCs.
  - UUID: 128-bit, not sortable, not numeric.
  - Ticket server (central auto-increment): a single point of failure.
  - **Twitter Snowflake**: 64 bits = sign(1) + **timestamp(41, ms since a custom epoch, about 69 yrs)** + datacenter(5) + machine(5) + **sequence(12, 4096/ms)**.
- Clock synchronisation via **NTP**. Section lengths can be tuned. High availability is required.

### 8. URL shortener

- API: `POST /api/v1/data/shorten` and `GET /api/v1/shortUrl`.
- **301 permanent redirect** is cached by the browser, so there is less load. **302 temporary** lets you track analytics.
- Storage: a table of `id, shortURL, longURL`. With 62⁷ ≈ 3.5 trillion values, a length of 7 is enough.
- **Hash + collision resolution**: take the first 7 characters of CRC32/MD5/SHA-1, recheck the database and append a salt on collision; a **Bloom filter** speeds up the lookup.
- **Base-62 conversion** of a unique ID from a Snowflake-like generator: no collisions, but the next ID is predictable.
- Read path: cache → database. Extras: rate limiting, analytics, scaling the web and database tiers.

### 9. Web crawler

- Characteristics: scalable, robust (bad HTML, crashes), **polite**, extensible.
- Flow: seed URLs → **URL frontier** → HTML downloader (DNS resolver) → content parser → "content seen?" (hash dedup) → link extractor → URL filter → "URL seen?" (Bloom filter or hash set) → back to the frontier.
- **BFS**, not DFS.
- **Frontier**:
  - **Politeness**: one queue per host, one worker per queue, delays between requests.
  - **Priority**: a prioritiser uses PageRank, traffic and update frequency to weight the front queues.
  - **Freshness**: recrawl based on update history and priority.
  - Mostly on disk, with in-memory buffers.
- Downloader: **robots.txt** cache, distributed crawl, DNS cache, locality, short timeouts.
- Robustness: consistent hashing for workers, saved crawl state, exception handling, validation.
- Problem content: redundant content (hash dedup), **spider traps** (max URL length, manual blocklists), data noise.
- Extras: server-side rendering for JavaScript, spam filtering, database replication and sharding, horizontal scaling.

### 10. Notification system

- Types: iOS push (**APNs**), Android (**FCM**), SMS (Twilio/Nexmo), email (SendGrid/Mailchimp).
- **Contact info gathering**: collect device tokens, phone numbers and emails at install or signup, in a `user` table and a `device` table (one user, many devices).
- **Improved design**:
  - Notification servers do authentication, rate limiting and validation, then fetch from a cache or database.
  - **One message queue per channel type** isolates failures.
  - **Workers** pull from the queues and call the third parties.
- **Reliability**: a **notification log** so nothing is lost and failures can be retried. **Dedup by event ID** because delivery is at-least-once.
- Also:
  - notification **templates**;
  - **notification settings / opt-out** per channel;
  - **rate limiting** per user;
  - **retry** with backoff;
  - **security**: appKey/appSecret for push APIs;
  - **monitoring** queued notifications;
  - **event tracking** (open, click, engagement).

### 11. News feed

- Two flows: **feed publishing** (write to cache and database, fan out to friends) and **feed retrieval**.
- **Fanout on write (push)**: real-time, fast reads; wasteful for inactive users; the hotkey problem with celebrities.
- **Fanout on read (pull)**: nothing wasted on inactive users; slow reads.
- **Hybrid**: push for most users, pull for celebrities. Use consistent hashing to spread hot keys.
- Fanout service: gets friend IDs from a graph database, filters them by user settings, then a queue feeds the workers, which write `<post_id, user_id>` to the news feed cache.
- Retrieval: fetch the post IDs from the cache, then hydrate them from the user and post caches. Media comes from the CDN.
- **5-layer cache**: news feed, content (hot content), social graph, action (likes/replies), counters.

### 12. Chat system

- 1:1 and small groups (≤100), online presence, multiple devices, push notifications. Scale: 50M DAU.
- **Protocol**:
  - Sending can use HTTP keep-alive.
  - Receiving options: polling, long polling (servers can't easily tell when a client disconnects), or **WebSocket**.
  - WebSocket is bidirectional and persistent, so it is used for both directions.
- **Stateless services**: login, signup, profile, service discovery (ZooKeeper picks the best chat server).
- **Stateful**: the chat servers, which hold the connections.
- **Third party**: push notifications.
- **Storage**: generic data in a relational database. **Chat history in a key-value store** (HBase/Cassandra), because the history is huge, recent messages are hot, and it needs random access for search/mentions and a read/write ratio of about 1:1.
- **Message ID**: must be unique and sortable by time. Use a local per-channel sequence, not a global one.
- **Flows**:
  - 1:1: sender → chat server → ID generator → message sync queue → KV store → online: WebSocket; offline: push.
  - Multi-device sync: each device keeps a `cur_max_message_id`.
  - Small groups: fan out a copy into each recipient's inbox queue.
- **Presence**: heartbeats every x seconds; offline after a timeout. Status is fanned out via pub/sub channels (fine for small groups).
- Extras: media, end-to-end encryption, client caching, load time, error handling (retry and queues).

### 13. Search autocomplete

- Return the top 5 results by historical frequency. Response time under 100 ms, prefix matching, lowercase only.
- **Data gathering**: analytics logs → aggregators (weekly, or real-time for Twitter-like freshness) → aggregated data → workers build the trie → **trie DB** (document store snapshot, or a KV store mapping prefix to data) → trie cache.
- **Trie optimisations**: limit the prefix length (e.g. 50), and **cache the top-k results at every node**, so a lookup is O(1) at the cost of extra space.
- **Query service**: AJAX requests, browser caching (`Cache-Control: max-age`), data sampling.
- **Trie operations**: rebuild weekly rather than update per query. Deleting (filtering hateful content) goes through a filter layer.
- **Scaling**: shard by first letter, then by the historical distribution, using a shard-map manager.
- Extras: multiple languages (Unicode), per-country tries, trending queries (stream processing).

### 14. YouTube

- Scale: 5M DAU, 5 videos/day, 10% upload 1 video (300 MB), 150 TB/day of storage. CDN cost is about $150K/day, which drives the design.
- **Components**: client, CDN (streams video), API servers (everything else), metadata DB and cache, **original storage (blob)**, **transcoding servers**, transcoded storage, completion queue and handler.
- **Upload flow**: the file goes to original storage; transcoding runs in parallel with the metadata update.
- **Streaming**: protocols such as MPEG-DASH, HLS, Smooth Streaming and HDS. Stream from the nearest CDN edge.
- **Transcoding**: several bitrates and formats for adaptive streaming. Modelled as a **DAG** (video → inspection, transcoding, thumbnail, watermark; audio encoding).
- **Transcoding architecture**:
  - Preprocessor splits into GOPs and caches the segments.
  - DAG scheduler.
  - Resource manager with task, worker and running queues.
  - Task workers.
  - Temporary storage (memory or blob).
  - Encoded video.
- **Optimisations**:
  - Parallel upload of GOP chunks, and upload centres close to users.
  - Parallelism with message queues between stages.
  - **Pre-signed URLs** for uploads.
  - Protection: **DRM**, AES encryption, watermarking.
  - **Cost**: serve only popular videos from the CDN (long-tail distribution), encode less for unpopular ones, run your own CDN or partner with ISPs.
- **Errors**: recoverable ones are retried; non-recoverable ones return an error code. Each component has its own retry and replica strategy.

### 15. Google Drive

- Upload/download, **file sync** across devices, revisions, sharing, notifications. Files up to 10 GB, 50M users, 10M DAU, 500 PB total.
- **Block servers**: split files into **4 MB blocks**, compress, encrypt, upload to cloud storage (S3).
  - **Delta sync**: only modified blocks are uploaded.
  - **Dedup**: blocks with the same hash are stored once.
- **Metadata DB** (strong consistency, relational, ACID): user, device, namespace, file, file_version (read-only history), block tables.
- **Upload flow**: add the file metadata as "pending" → upload to the block servers → cloud storage callback → mark "uploaded" → notify the other clients.
- **Notification service**: **long polling**. Communication is not bidirectional and notifications are infrequent, so WebSocket isn't needed.
- **Sync conflicts**: the first version to be processed wins; the later one is saved as a conflict copy.
- **Save storage**: dedup blocks, an intelligent backup strategy (limit the number of versions, keep valuable ones), move infrequent data to **cold storage** (S3 Glacier).
- **Failure handling**: load balancer (heartbeats and a secondary), block server, cloud storage (cross-region), API server, metadata cache and database (replication), notification service (reconnect slowly), offline backup queue.

---

## Part C: Vol. 2 designs

### 16. Proximity service (Yelp nearby)

- `GET /v1/search/nearby?lat&long&radius`, plus business CRUD. Updates can take effect the next day. 100M DAU, 200M businesses, 5K search QPS.
- **Location-Based Service (LBS)**: read-only, stateless, scales horizontally. Separate from the **business service** (writes).
- **Database**: primary for writes plus read replicas.
- **Geo indexing options**:
  - 2D range search (slow).
  - **Evenly divided grid**: uneven density.
  - **Geohash**: recursively halve the world into a base-32 string. Precision 4–6 maps to radii of 20 km–0.5 km.
    - Edge cases: neighbouring cells can have no common prefix, so query the current cell plus its 8 neighbours.
    - If there are not enough results, increase the radius by dropping precision.
  - **Quadtree**: in-memory tree split until each leaf has ≤100 businesses; about 1.71 GB. Rebuilt at startup, which takes minutes; roll out incrementally.
  - **Google S2**: Hilbert curve, geofencing, region cover.
- Choice: **geohash table** `(geohash, business_id)`. Cache: `geohash → [business_ids]` and `business_id → object`.
- Scale: replicas rather than sharding for the geo index; region and AZ deployment; filters applied after fetching.

### 17. Nearby friends

- Show friends within 5 miles, updated every 30 s; hide inactive users after 10 minutes. 100M DAU, 10M concurrent, **334K location updates/s**.
- **WebSocket servers** (stateful) for bidirectional location updates. **API servers** handle the rest.
- **Redis location cache** holds the latest location with a TTL (inactive users expire).
- **Location history DB**: Cassandra (write-heavy).
- **Redis pub/sub**: one channel per user. Friends subscribe to it; on an update, each subscriber's WebSocket handler computes the distance and pushes the update if it is within range.
- **Scaling**:
  - WebSocket servers: drain connections before removing a node.
  - Location cache: shard by user ID.
  - Pub/sub: memory is modest (about 200 GB); CPU is the real limit (about 14M pushes/s), so use about 100 servers.
  - Shard pub/sub with a **hash ring** in ZooKeeper/etcd. Resizing is disruptive, so over-provision.
- Adding or removing friends means subscribe/unsubscribe callbacks.
- Users with many friends: cap the friend count; the load spreads naturally.
- "Nearby random people": pub/sub channel per **geohash** grid (the current cell plus 8 neighbours).
- Alternative: Erlang/OTP for lightweight processes.

### 18. Google Maps

- Location updates, navigation with ETA, map rendering. 1B DAU.
- **Map basics**:
  - Projection: Web Mercator.
  - Geocoding: address to lat/lng.
  - Geohashing for tiles.
  - **Map tiles** are pre-computed PNGs per **zoom level** (21 levels; level 0 is one tile).
  - **Routing tiles**: graph data of nodes and edges at 3 levels of detail.
  - Routing algorithms: Dijkstra / **A\***.
- **Location service**: clients **batch** location updates every 15 s. Written to **Cassandra**; also sent to **Kafka** for traffic, ETA and personalisation.
- **Map rendering**: tiles are served from a **CDN** via a static URL built from geohash and zoom. Client-side caching. Vector tiles save bandwidth.
- **Navigation service**:
  - geocoding;
  - route planner;
  - shortest-path service on the routing tiles in object storage;
  - ETA service using ML on live and historical traffic;
  - ranker applies filters (e.g. avoid tolls);
  - updater services consume from Kafka.
- **Adaptive ETA and rerouting**: track the users on affected routes (a tile hierarchy per user). Push over **WebSocket** (or SSE).

### 19. Distributed message queue (Kafka-like)

- Producers send to **topics**, which are split into **partitions** (ordered, spread across **brokers**). Each message has an **offset**.
- **Consumer groups**: each partition is consumed by exactly one consumer in the group. That gives ordering within a partition, and the number of partitions limits the group size.
- **Storage**: a **write-ahead log** split into segments (append-only, sequential disk I/O, relies on the OS page cache). No relational database.
- **Message**: key (decides the partition), value, topic, partition, offset, timestamp, size, CRC.
- **Batching** on producer, broker and consumer trades latency for throughput.
- **Producer**: a routing layer inside the producer library, with buffering.
- **Consumer**: **pull** model, so the consumer controls its rate.
- **Consumer rebalancing** is run by a coordinator broker using heartbeats.
- **State storage** (consumer→partition mapping and committed offsets) and **metadata storage** (topic config) live in **ZooKeeper**.
- **Replication**: a leader and followers per partition. **ISR** (in-sync replicas) are defined by a lag threshold.
- **ACK settings**:
  - ack=all: strongest durability.
  - ack=1: the leader alone.
  - ack=0: fastest, may lose data.
- **Delivery semantics**:
  - At-most-once: ack=0, commit before processing.
  - At-least-once: ack=1/all, commit after processing, possible duplicates.
  - **Exactly-once**: hardest (idempotent producer plus transactions).
- **Scaling**: add brokers and partitions; migrate replicas. Removing a partition is handled with retention.
- **Extras**:
  - message filtering by tags;
  - **delayed/scheduled messages**, sent to temporary storage and then delivered;
  - retry topic and dead-letter topic.

### 20. Metrics monitoring and alerting

- Operational metrics (CPU, requests, latency, errors). 100M metrics/day, 1-year retention with **down-sampling** (raw for 7 days, 1-minute resolution for 30 days, 1-hour resolution for 1 year). Alerts go to email, phone, PagerDuty and webhooks.
- **Data model**: time series (name, labels/tags, timestamp, value). Write-heavy, with spiky reads.
- **Time-series database** (InfluxDB, Prometheus, OpenTSDB): optimised for writes and label indexes.
- **Collection**:
  - **Pull** (Prometheus scraping via service discovery; easy health checks) or **push** (collection agents; better for short-lived jobs and complex networks). Both are valid.
  - **Kafka** between collectors and the database buffers against database outages.
- **Aggregation** can happen in the collection agent, the ingestion pipeline (Flink) or at query time.
- **Query service** plus a cache. Visualisation with **Grafana**.
- **Storage**: most queries hit the last 26 h. Use data encoding and compression (delta, double-delta), down-sampling and cold storage.
- **Alerting**:
  - rules in **YAML**, loaded into a cache;
  - alert manager evaluates the rules, **deduplicates/merges**, handles access control and **retries**;
  - alert store (Cassandra) keeps state (inactive / pending / firing / resolved);
  - alerts go to Kafka, then a consumer, then the channels.
- **Build vs. buy**: off-the-shelf tools are usually the right answer.

### 21. Ad click event aggregation

- 1B clicks/day (10K QPS, peak 50K), 2M ads.
- Queries:
  - clicks for an ad in the last M minutes;
  - top 100 ads in the last minute;
  - filters by IP, user or country.
- End-to-end latency of a few minutes. **Correctness is critical, because billing depends on it.**
- **API**:
  - `GET /v1/ads/{ad_id}/aggregated_count?from&to&filter`
  - `GET /v1/ads/popular_ads?count&window&filter`
- **Data**: keep **raw** events (for recalculation and debugging, in cold storage) _and_ **aggregated** per-minute rows (`ad_id, click_minute, filter_id, count`) plus `most_clicked_ads`. Cassandra (write-heavy).
- **Pipeline**: raw events go to **Kafka**, then the **aggregation service** (MapReduce DAG: map → aggregate → reduce, with a heap for top-N), then a second Kafka topic, then the aggregation DB. The second queue enables end-to-end **exactly-once**.
- **Filtering**: pre-aggregated with a **star schema** (dimensions). This multiplies the number of buckets.
- **Streaming vs. batch**:
  - **Lambda** architecture: two processing paths.
  - **Kappa**: a single stream path; reprocessing replays the raw data through a separate aggregation service. This design uses Kappa.
- **Time**:
  - **Event time** (accurate, but late events arrive) vs. processing time.
  - **Watermarks** extend the window: longer means fewer misses but more latency.
  - Stragglers are fixed by **end-of-day reconciliation**.
- **Windows**: tumbling (per-minute counts), sliding (top-N), plus hopping and session windows.
- **Exactly-once / dedup**:
  - Duplicates come from client resends and from a node crashing before it acks.
  - Store the offset _atomically with_ the downstream write, via a distributed transaction or an idempotent downstream.
- **Scale**:
  - Kafka partitions and consumer groups (rebalance off-peak; partition topics by geography).
  - Aggregation nodes via multithreading or YARN.
  - Cassandra with consistent hashing.
  - **Hotspot ads** get extra aggregation nodes; alternatives are global-local or split-distinct aggregation.
- **Fault tolerance**: Kafka offsets plus **snapshots** of in-memory state (top-N).
- **Monitoring**: latency, **records-lag**, resource use. Nightly **reconciliation** of raw data against the aggregates.
- Off-the-shelf alternative: Hive + Elasticsearch, with ClickHouse or Druid for OLAP.

### 22. Hotel reservation system (Marriott / Airbnb / tickets)

- 5,000 hotels, 1M rooms. Pay in full at booking. Cancellation allowed. **Overbooking up to 10%**. Prices change daily.
- About 3 reservation TPS, but there are traffic surges.
- **API**:
  - hotels and rooms (CRUD for ops);
  - `POST /v1/reservations` with **`reservationID` as the idempotency key**;
  - `GET` and `DELETE /v1/reservations/{id}`.
- **Relational DB**: read-heavy, **ACID** prevents a negative balance or a double charge, and the data is clearly structured.
- **Services**:
  - Hotel service: static and cached.
  - Rate service: prices depend on occupancy.
  - Reservation service: also owns inventory.
  - Payment service.
  - Hotel management service (internal, behind a VPN).
  - Public API gateway with rate limiting and auth; CDN.
- **Improved model**: reserve a **room type**, not a room. `room_type_inventory(hotel_id, room_type_id, date, total_inventory, total_reserved)`, one row per day, pre-populated by a cron job (about 73M rows over 2 years). Availability check: `total_reserved + n <= 110% × total_inventory`.
- **Double booking**:
  - _Same user clicks twice_: disabling the button on the client isn't enough, so use an **idempotent API**. The reservation ID is generated when the reservation form is created and has a **unique constraint**.
  - _Multiple users at the same time_: without serializable isolation, both check and both commit. Fixes:
    - **Pessimistic locking** (`SELECT … FOR UPDATE`): risk of deadlocks, doesn't scale. Not recommended.
    - **Optimistic locking** with a **version column**: good when contention is low. Recommended.
    - **Database constraint** `CHECK (total_inventory - total_reserved >= 0)`: simple, but harder to version-control.
- **Scale** (e.g. booking.com at 1,000× the load):
  - Services are stateless.
  - **Shard by `hash(hotel_id)`** (16 shards means about 1,875 QPS each).
  - **Redis inventory cache** keyed `hotelID_roomTypeID_date` with a TTL, kept in sync by **CDC (Debezium)**. A stale cache is acceptable because the **database is the final guard**.
  - Move history to cold storage.
- **Consistency across services**:
  - Keep reservation and inventory **in the same database** for ACID.
  - Otherwise use **2PC** (blocking, slow) or **Saga** (local transactions plus compensations, eventually consistent).
  - Question whether the extra complexity is worth it.

### 23. Distributed email service (Gmail)

- 1B users, about 100K emails/s sent. Metadata about 730 PB/yr; attachments about 1,460 PB/yr.
- **Protocols**: SMTP (server to server), POP (download and delete), IMAP (keep on the server), HTTPS for webmail. DNS **MX records**. Attachments are base64 with about a 25 MB limit.
- Traditional servers stored one file per email on local disk, which doesn't scale.
- **Distributed design**:
  - webmail and web servers (REST: `POST /v1/messages`, `GET /v1/folders`, `GET /v1/folders/{id}/messages`, `GET /v1/messages/{id}`);
  - **real-time servers** (WebSocket, with a long-poll fallback);
  - metadata DB;
  - **attachment store** (S3);
  - distributed cache (recent emails in Redis);
  - **search store**.
- **Send flow**:
  - The load balancer rate-limits.
  - Web servers validate. Same-domain mail short-circuits delivery, after a spam check.
  - Valid mail goes to the **outgoing queue**; invalid mail goes to an error queue.
  - SMTP outgoing workers run spam and virus checks and deliver with **exponential-backoff retry**.
  - The message is stored in "Sent".
  - **Monitor the outgoing queue size.**
- **Receive flow**: SMTP load balancer → SMTP servers (acceptance policy) → large attachments go to S3 → incoming queue → mail processing workers (spam/virus) → storage, cache, search and real-time servers. Offline users fetch over HTTP later.
- **Metadata DB**:
  - Operations are per user, recent mail is hot, and the data must not be lost.
  - Partition by **`user_id`**.
  - Cassandra-like tables: folders; emails keyed by `timeuuid`; attachments.
  - **Denormalised read/unread tables**, because you can't filter on non-key columns.
  - Threads are rebuilt from the `Message-Id`, `In-Reply-To` and `References` headers.
  - **Choose consistency over availability.**
- **Deliverability**:
  - dedicated IPs;
  - separate marketing mail from transactional mail;
  - **IP warm-up** (2–6 weeks);
  - ban spammers quickly;
  - ISP feedback loops;
  - **SPF, DKIM, DMARC**.
- **Search**: local to the user, more writes than reads.
  - **Elasticsearch** partitioned by `user_id`; reindexing is async via Kafka; searching is synchronous.
  - Or a custom engine on **LSM trees**.
- **Availability**: multi-DC with leader-follower failover. Also consider GDPR/PII, encryption, phishing protection and attachment dedup.

### 24. S3-like object storage

- **Storage types**:
  - **Block** (HDD/SSD; for VMs and databases).
  - **File** (NFS/SMB).
  - **Object**: immutable, flat namespace, REST, cheap, vast scale, slower.
- **Terms**: bucket (globally unique name), object (data plus metadata), versioning, URI, SLA (e.g. 11 nines of durability, 99.9% availability).
- **Requirements**: 100 PB/year, **6 nines of durability**, 4 nines of availability, storage efficiency. About 0.68B objects and about 0.68 TB of metadata.
- **Properties**: immutable, a key-value store, write once and read many (about 95% reads). **Metadata is separate from data**, like a UNIX inode.
- **Design**: load balancer → **API service** (stateless) → **IAM** (authn/authz) → **metadata store** and **data store**.
  - Upload: `PUT` the bucket, then `PUT` the object. The data store returns a UUID, which is recorded in the metadata.
  - Download: IAM check → UUID from the metadata → bytes from the data store.
- **Data store**:
  - **Data routing service** (stateless).
  - **Placement service**: a virtual cluster map with heartbeats, run as a 5- or 7-node **Raft/Paxos** cluster.
  - **Data nodes**: the primary writes and replicates to 2 secondaries _before_ acknowledging (strong consistency). The replica group is chosen by **consistent hashing**.
- **Data layout**:
  - Many small files waste 4 KB blocks and inodes, so **append objects into large WAL-style files** (a few GB), with one file per core to avoid lock contention.
  - An **object mapping table** `(object_id, filename, offset, size)` lives in a per-node **SQLite**.
- **Durability**:
  - Replicate across **failure domains** (rack, DC). 3 replicas of an HDD with 0.81% annual failure rate give about 6 nines.
  - **Erasure coding (8+4)**: about 50% overhead vs. 200% for replication, about 11 nines, but slower reads and more CPU.
  - **Checksums** per file and per object detect silent corruption.
- **Metadata**:
  - The bucket table is small. The object table is **sharded by `hash(bucket_name, object_name)`**.
  - **Listing by prefix** across shards is slow (scatter-gather plus pagination pain), so use a denormalised listing table sharded by bucket.
- **Versioning**: an `object_version` TIMEUUID column. Deleting inserts a **delete marker**, so reads return 404.
- **Multipart upload**: initiate (upload ID) → upload the parts (each returns an ETag/MD5) → complete (part list plus ETags) → reassemble.
- **Garbage collection**: lazy deletes, orphaned parts and corrupt data are reclaimed by **compaction** (copy the live objects to a new file, then update the mapping in a transaction).

### 25. Real-time gaming leaderboard

- A point per win. Monthly tournaments. Top 10 plus the user's rank (and ±4 around them). Real-time. 5M DAU / 25M MAU, about 2,500 peak score updates/s.
- **API**:
  - `POST /v1/scores` is **only callable by game servers, never by clients**, because clients can tamper with scores.
  - `GET /v1/scores` returns the top 10.
  - `GET /v1/scores/{user_id}` returns one user's score and rank.
- A relational database with an index on score plus `LIMIT` handles the top 10, but finding one user's rank needs a `COUNT(*)` scan, which doesn't scale.
- **Redis sorted set** (hash map plus **skip list**), one key per month:
  - `ZINCRBY lb_feb 1 user` to add a point;
  - `ZREVRANGE 0 9 WITHSCORES` for the top 10;
  - `ZREVRANK` for a rank;
  - `ZREVRANGE rank-4 rank+4` for the neighbours.
  - All are O(log N). 25M users take about 650 MB.
  - A replica plus persistence, with MySQL for users and the game history so the leaderboard can be rebuilt.
- Serverless alternative: API Gateway + Lambda.
- **Scaling Redis** (500M DAU): **fixed range partitions by score** (preferred: the top 10 comes from the top shard, and rank = rank within the shard + counts of higher shards) vs. hash partitioning with Redis Cluster (the top-K needs scatter-gather, and there is no easy rank).
- **NoSQL alternative** (DynamoDB): score as the sort key, and **write sharding** `month#partition` to avoid a hot partition. Scatter-gather for reads. Show **percentiles** instead of an exact rank.
- **Ties** are broken by the time of the last win.

### 26. Payment system (e-commerce backend)

- Pay-in and pay-out, credit cards via a **PSP** (Stripe/Braintree). **No card data is stored**, for compliance. About 10 TPS, so the focus is correctness, reliability and **reconciliation**.
- **Components**:
  - **Payment service**: coordinates and runs risk/AML checks.
  - **Payment executor**: one payment order per call to the PSP.
  - **PSP** and **card schemes**.
  - **Ledger**: financial record.
  - **Wallet**: merchant balances.
- **API**: `POST /v1/payments` with `checkout_id` and `payment_orders[]`. Each has a **`payment_order_id` idempotency key, sent on to the PSP**, and the **amount as a string (never a double)**. `GET /v1/payments/{id}`.
- **Tables**:
  - `payment_event(checkout_id PK, buyer, seller, card info, is_payment_done)`.
  - `payment_order(payment_order_id PK, amount, currency, checkout_id FK, status NOT_STARTED/EXECUTING/SUCCESS/FAILED, ledger_updated, wallet_updated)`.
  - A background job watches in-flight payments and **alerts if they are stuck**.
  - A proven **SQL** database with ACID.
- **Double-entry ledger**: every movement debits one account and credits another, and the entries sum to zero. Gives full traceability.
- **Hosted payment page**:
  1. Register the payment with the PSP (with an idempotency UUID) and get back a **token**, which is stored.
  2. Show the PSP page with the token and a redirect URL.
  3. The PSP processes the payment and redirects the user back.
  4. **Asynchronously, the PSP webhook tells the backend the real result**, and the backend records it.
- **Reconciliation**: a nightly **PSP settlement file** is compared with the internal state (and the ledger with the wallet). Mismatches are auto-fixable, manually fixable, or need investigation.
- **Delays** (manual risk review, 3DS): show a _pending_ status and wait for the webhook, or poll if there is none. Notify the user when it completes.
- **Communication**: synchronous calls are simple but fragile; **asynchronous** (Kafka, multiple receivers) is better, because one payment triggers many side effects.
- **Failed payments**:
  - track the state;
  - a **retry queue**;
  - a **dead-letter queue**.
- **Exactly-once** = at-least-once (retries with **exponential backoff**, honouring `Retry-After`) + at-most-once (**idempotency key**: a unique constraint means a duplicate insert returns the existing record). The PSP also dedups on the nonce.
- **Consistency**: read from the primary (avoids replica lag), or use consensus databases (CockroachDB/Yugabyte). Exactly-once plus reconciliation gives eventual consistency across the PSP, ledger and wallet.
- **Security**:
  - HTTPS;
  - integrity monitoring;
  - certificate pinning;
  - multi-region replication and snapshots;
  - rate limiting and a WAF;
  - **tokenisation**;
  - PCI DSS;
  - fraud checks (AVS, CVV, behaviour).
- Also consider: monitoring, debugging tools, FX, regional payment methods, **cash payments (common in India and Brazil)**, Google/Apple Pay.

### 27. Digital wallet

- Wallet-to-wallet transfers. **1M TPS**, 99.99% availability, transactional, and **reproducible** (replay history, not just reconcile).
- One relational node handles about 1K TPS; a transfer has 2 legs, so about 2,000 nodes. Goal: raise the throughput per node.
- **API**: `POST /v1/wallet/balance_transfer` (from, to, **amount as a string**, currency, **`transaction_id` idempotency key**).
- Evolution:
  1. **Redis sharded by account** (partition config in ZooKeeper): fast, but **not atomic and not durable**.
  2. **Distributed transactions** over sharded databases:
     - **2PC**: prepare/commit; lock contention; the coordinator is a single point of failure.
     - **TC/C (Try-Confirm/Cancel)**: two independent local transactions with compensation.
       - **Always deduct first** (Try: A−1, C: no-op), so the intermediate state can't be spent.
       - A **phase status table** lets the coordinator recover.
       - An **out-of-order flag** handles a Cancel that arrives before its Try.
       - Can run in parallel.
     - **Saga**: linear steps plus compensating rollback. **Orchestration** is preferred over choreography.
     - TC/C for low latency; Saga for simplicity.
  3. **Event sourcing**:
     - **Command** (the intent; may fail; FIFO), **event** (an immutable fact), **state** (balances), **deterministic state machine** (validates commands, applies events).
     - Replaying events answers "balance at time T?", "are the balances correct?" and "is the new code correct?"
     - **CQRS**: read-only state machines serve queries.
  4. **High-performance event sourcing**:
     - Local append-only files via **mmap** instead of Kafka.
     - State in **RocksDB** (LSM).
     - Periodic **snapshots** (to HDFS).
  5. **Reliability**: only the **event list** must be durable (state and snapshots are derivable; commands aren't deterministic). Replicate it with **Raft**.
  6. **Distributed event sourcing**:
     - Shard into many Raft groups, coordinated by TC/C or Saga.
     - A reverse proxy plus **push** from the read state machines instead of polling.

### 28. Stock exchange

- Stocks only, limit orders (place and cancel), real-time fills and order book, about 100 symbols, 1B orders/day (43K QPS, 215K peak at market open).
- Requirements: risk checks (e.g. a daily volume cap), **funds withheld for pending orders**, 99.99% availability, **millisecond p99 latency**, KYC, DDoS protection.
- **Concepts**: broker; limit vs. market order; bid/ask; L1/L2/L3 market data; candlesticks; the **FIX** protocol.
- **Trading flow (critical path)**:
  1. Client gateway: authentication, validation, rate limiting; kept lightweight.
  2. **Order manager**: risk check, then a **wallet funds check**.
  3. **Sequencer**: stamps inbound orders and outbound fills with **sequence IDs**, for fairness, replay and exactly-once.
  4. **Matching engine**: order book per symbol; emits 2 fills (buy and sell) in deterministic order.
- **Market data flow**: the publisher builds the order book and candlesticks, then the data service serves them.
- **Reporting flow** (off the critical path; accuracy matters more than speed).
- **API**:
  - `POST /v1/order` (symbol, side, price, orderType, quantity);
  - `GET /execution`;
  - `GET /marketdata/orderBook/L2`;
  - `GET /marketdata/candles`.
- **Order book**:
  - A price-level map, with a **doubly-linked list** of orders per level.
  - An `orderMap` gives O(1) add, match and cancel.
  - Best bid and best ask are tracked.
  - **FIFO matching** within a price level.
- **Candlesticks**: ring buffers; an in-memory columnar database (KDB); persisted after market close.
- **Performance**:
  - Everything on **one big server**.
  - Components talk through **mmap in `/dev/shm`** as the event store.
  - An **application loop pinned to a CPU core**, so no context switches and no locks.
  - No logging on the critical path.
  - Target: tens of microseconds.
- **Event sourcing** as in chapter 27. The order manager ships as a library inside each component. The sequencer is the **single writer**.
- **High availability**:
  - Hot/warm standby that processes inbound events but doesn't publish.
  - Heartbeats and automated failover.
  - **Raft** leader election across servers; event store replicated over reliable UDP.
  - Manual failover at first. Chaos engineering. Define the RTO. Data loss is unacceptable.
- **Determinism**: functional (via the sequencer) and latency (watch p99/p99.99; GC pauses cause spikes).
- **Market data fairness**: **multicast** over reliable UDP so everyone receives data at the same time. Ring buffers with cache-line padding.
- **Colocation** as a paid service.
- **Security**:
  - isolate public services from private ones;
  - cache;
  - cacheable URLs;
  - allow/block lists;
  - rate limiting.

---

## Cross-cutting patterns

| Pattern                                                   | Chapters           |
| --------------------------------------------------------- | ------------------ |
| Idempotency key + unique constraint                       | 22, 26, 27         |
| Exactly-once = at-least-once + dedup                      | 10, 19, 21, 26     |
| Outbox / async queue with retry and DLQ                   | 10, 19, 23, 26     |
| Reconciliation (nightly batch vs. source of truth)        | 21, 26, 27         |
| DB constraint as the final guard, cache may be stale      | 22                 |
| Optimistic vs. pessimistic locking                        | 22                 |
| Consistent hashing / sharding by the dominant query key   | 5, 6, 22, 23, 24   |
| Geohash / quadtree for "nearby"                           | 16, 17, 18         |
| WebSocket for push, long-poll fallback                    | 12, 15, 17, 18, 23 |
| Event sourcing + deterministic state machine + snapshots  | 27, 28             |
| Consensus (Raft/Paxos) for critical metadata              | 24, 27, 28         |
| Server-authoritative writes (never trust the client)      | 4, 25, 26          |
| Money as string/integer, never float; double-entry ledger | 26, 27             |
| Monitoring queue lag and alert rules                      | 10, 20, 21, 23     |
