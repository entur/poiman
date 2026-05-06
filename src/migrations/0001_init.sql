create table pois (
  id          bigserial primary key,
  name        text not null,
  poi_type    text not null,
  longitude   double precision not null,
  latitude    double precision not null,
  valid_from  timestamptz not null,
  valid_to    timestamptz not null,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index pois_valid_to_idx on pois (valid_to) where deleted_at is null;
create index pois_deleted_at_idx on pois (deleted_at);
