terraform {
  backend "gcs" {
    bucket = "ent-gcs-tfa-poiman"
  }
}

module "init" {
  source      = "github.com/entur/terraform-google-init//modules/init?ref=v1.1.1"
  app_id      = "poiman"
  environment = var.environment
}

module "postgresql" {
  source           = "github.com/entur/terraform-google-sql-db//modules/postgresql?ref=v1.10.2"
  init             = module.init
  databases        = ["poiman"]
  database_version = "POSTGRES_18"
}
