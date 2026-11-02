-- Per-activity GPS panels and the activity dropdown look up one ActivitySelector at a time.
CREATE INDEX samples_activity_selector ON samples (source_id, (tags->>'ActivitySelector'), time)
 WHERE dataset='ActivityGPS';
