-- 0002 Service areas: city → zone → locality, pincodes and serviceability.
-- Nothing here is specific to one city; cities are data, activated by operations.

CREATE TABLE city (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  name          text NOT NULL,
  state_name    text NOT NULL,
  country_code  char(2) NOT NULL DEFAULT 'IN',
  time_zone     text NOT NULL DEFAULT 'Asia/Kolkata',
  is_active     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE zone (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id           uuid NOT NULL REFERENCES city (id),
  code              text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name              text NOT NULL,
  center_lat        numeric(9, 6) NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lng        numeric(9, 6) NOT NULL CHECK (center_lng BETWEEN -180 AND 180),
  service_radius_m  int NOT NULL CHECK (service_radius_m BETWEEN 100 AND 100000),
  -- Optional precise boundary (GeoJSON Polygon/MultiPolygon) for later map-based checks.
  boundary_geojson  jsonb,
  is_active         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_id, code)
);

CREATE TABLE pincode (
  code        text PRIMARY KEY CHECK (code ~ '^[1-9][0-9]{5}$'),
  city_id     uuid NOT NULL REFERENCES city (id),
  is_active   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE locality (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id     uuid NOT NULL REFERENCES zone (id),
  pincode     text NOT NULL REFERENCES pincode (code),
  name        text NOT NULL,
  center_lat  numeric(9, 6) CHECK (center_lat BETWEEN -90 AND 90),
  center_lng  numeric(9, 6) CHECK (center_lng BETWEEN -180 AND 180),
  is_active   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (zone_id, name)
);

CREATE INDEX locality_pincode_idx ON locality (pincode);

-- Great-circle distance in metres (haversine); adequate for service-radius checks.
CREATE FUNCTION distance_m(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
RETURNS double precision
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT 2 * 6371000 * asin(sqrt(
    power(sin(radians((lat2 - lat1)::double precision) / 2), 2) +
    cos(radians(lat1::double precision)) * cos(radians(lat2::double precision)) *
    power(sin(radians((lng2 - lng1)::double precision) / 2), 2)
  ))
$$;

-- Active localities that can serve a pincode (and, when coordinates are known, whose
-- zone radius covers the point). Callers pick the nearest.
CREATE VIEW serviceable_locality AS
SELECT l.id AS locality_id, l.name AS locality_name, l.pincode,
       z.id AS zone_id, z.code AS zone_code, z.center_lat, z.center_lng, z.service_radius_m,
       c.id AS city_id, c.code AS city_code, c.time_zone
FROM locality l
JOIN zone z ON z.id = l.zone_id
JOIN city c ON c.id = z.city_id
JOIN pincode p ON p.code = l.pincode
WHERE l.is_active AND z.is_active AND c.is_active AND p.is_active;

CREATE TRIGGER city_updated_at BEFORE UPDATE ON city FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER zone_updated_at BEFORE UPDATE ON zone FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER pincode_updated_at BEFORE UPDATE ON pincode FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER locality_updated_at BEFORE UPDATE ON locality FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER city_audit AFTER INSERT OR UPDATE OR DELETE ON city
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER zone_audit AFTER INSERT OR UPDATE OR DELETE ON zone
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
CREATE TRIGGER pincode_audit AFTER INSERT OR UPDATE OR DELETE ON pincode
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('code');
CREATE TRIGGER locality_audit AFTER INSERT OR UPDATE OR DELETE ON locality
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('id');
