//! Topic creation.
//!
//! Auto-creation only happens on produce, so a consumer that starts before any
//! data has been published subscribes to topics that do not exist and gets a
//! stream of `UnknownTopicOrPartition`. Creating them up front also avoids
//! inheriting the broker's default partition count, which is usually 1.

use std::time::Duration;

use rdkafka::ClientConfig;
use rdkafka::admin::{AdminClient, AdminOptions, NewTopic, TopicReplication};
use rdkafka::client::DefaultClientContext;
use rdkafka::error::{KafkaError, RDKafkaErrorCode};

use crate::config::KafkaConfig;
use crate::stream::topics::Signal;

pub async fn ensure_topics(config: &KafkaConfig) -> anyhow::Result<()> {
    let admin: AdminClient<DefaultClientContext> = ClientConfig::new()
        .set("bootstrap.servers", &config.brokers)
        .create()?;

    let topics: Vec<String> = Signal::ALL
        .iter()
        .map(|signal| signal.topic(&config.topic_prefix))
        .collect();
    let max_bytes = config.max_message_bytes.to_string();

    let new_topics: Vec<NewTopic<'_>> = topics
        .iter()
        .map(|topic| {
            NewTopic::new(
                topic,
                config.partitions,
                TopicReplication::Fixed(config.replication),
            )
            .set("max.message.bytes", &max_bytes)
        })
        .collect();

    let options = AdminOptions::new().request_timeout(Some(Duration::from_secs(10)));

    for result in admin.create_topics(&new_topics, &options).await? {
        match result {
            Ok(topic) => tracing::info!(%topic, "topic created"),
            // Another replica won the race, or the topic predates this process.
            Err((_, RDKafkaErrorCode::TopicAlreadyExists)) => {}
            Err((topic, code)) => {
                return Err(anyhow::Error::new(KafkaError::AdminOp(code))
                    .context(format!("creating topic `{topic}`")));
            }
        }
    }

    Ok(())
}
