-- Keep malformed legacy text visible in JSONB but absent from numeric aggregates.
CREATE FUNCTION health_number(document jsonb, field_name text) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN jsonb_typeof(document->field_name) = 'number'
 THEN (document->>field_name)::double precision ELSE NULL END
$$;
