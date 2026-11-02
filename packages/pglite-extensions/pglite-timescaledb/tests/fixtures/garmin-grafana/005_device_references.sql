-- Hypertables reference ordinary provenance tables; no hypertable-to-hypertable FK.
ALTER TABLE records ADD CONSTRAINT records_device_fk
 FOREIGN KEY(source_id,device_id) REFERENCES devices(source_id,id);
ALTER TABLE samples ADD CONSTRAINT samples_device_fk
 FOREIGN KEY(source_id,device_id) REFERENCES devices(source_id,id);
