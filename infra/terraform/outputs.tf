output "oci_instance_public_ip" {
  description = "IP pública del nodo OCI Always Free"
  value       = oci_core_instance.k3s_node.public_ip
}

output "oci_vcn_id" {
  description = "OCID de la VCN"
  value       = oci_core_vcn.main.id
}

output "aws_s3_bucket" {
  description = "Bucket S3 de artefactos"
  value       = aws_s3_bucket.artifacts.bucket
}

output "aws_sqs_tasks_url" {
  description = "URL de la cola principal de tareas"
  value       = aws_sqs_queue.tasks.url
}

output "aws_sqs_dlq_url" {
  description = "URL de la cola de mensajes muertos"
  value       = aws_sqs_queue.dlq.url
}
