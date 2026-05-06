variable "environment" {
  description = "Entur environment short name (dev, tst, prd)."
  type        = string
  validation {
    condition     = contains(["dev", "tst", "prd"], var.environment)
    error_message = "environment must be one of dev, tst, prd."
  }
}
