variable "project_name" {
  description = "Nombre base de los recursos"
  type        = string
  default     = "agentic-workflow"
}

# ---- Oracle Cloud ----
variable "tenancy_ocid" {
  description = "OCID del tenancy de OCI"
  type        = string
}

variable "user_ocid" {
  description = "OCID del usuario de OCI"
  type        = string
}

variable "compartment_ocid" {
  description = "OCID del compartimento donde se crean los recursos"
  type        = string
}

variable "fingerprint" {
  description = "Huella de la API key de OCI"
  type        = string
}

variable "private_key_path" {
  description = "Ruta a la llave privada de la API key de OCI"
  type        = string
}

variable "oci_region" {
  description = "Región de OCI"
  type        = string
  default     = "sa-santiago-1"
}

variable "oci_instance_shape" {
  description = "Shape Always Free (Ampere A1)"
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "oci_instance_ocpus" {
  description = "OCPUs (límite Always Free: 4 en total)"
  type        = number
  default     = 2

  validation {
    condition     = var.oci_instance_ocpus >= 1 && var.oci_instance_ocpus <= 4
    error_message = "Always Free permite entre 1 y 4 OCPUs Ampere A1."
  }
}

variable "oci_instance_memory_gbs" {
  description = "Memoria en GB (límite Always Free: 24 en total)"
  type        = number
  default     = 12

  validation {
    condition     = var.oci_instance_memory_gbs >= 1 && var.oci_instance_memory_gbs <= 24
    error_message = "Always Free permite hasta 24 GB de memoria Ampere A1."
  }
}

variable "ssh_public_key" {
  description = "Llave pública SSH autorizada en la instancia"
  type        = string
}

variable "admin_cidr" {
  description = "CIDR autorizado para SSH (ej. 203.0.113.10/32)"
  type        = string

  validation {
    condition     = var.admin_cidr != "0.0.0.0/0"
    error_message = "Por seguridad, SSH no puede abrirse a 0.0.0.0/0."
  }
}

# ---- AWS ----
variable "aws_region" {
  description = "Región de AWS"
  type        = string
  default     = "us-east-2"
}

variable "s3_bucket_name" {
  description = "Nombre globalmente único del bucket S3 de artefactos"
  type        = string
}
