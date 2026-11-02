-- Key/value facts about the running application, e.g. its version, for Grafana to display.
CREATE TABLE app_info (
 key text PRIMARY KEY,
 value text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
