# Slice 6 LoRA training (ADR-006). Runs on a RunPod GPU pod (any 24GB+ card).
#
#   pip install unsloth
#   python train.py
#
# Trains Qwen2.5-7B-Instruct on finetune/train.jsonl (teacher-labeled triage
# classifications) and exports a q4_k_m GGUF for local inference via Ollama.
from unsloth import FastLanguageModel
from unsloth.chat_templates import get_chat_template
from datasets import load_dataset
from trl import SFTConfig, SFTTrainer

MAX_SEQ = 4096
MODEL = "unsloth/Qwen2.5-7B-Instruct"

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=MODEL,
    max_seq_length=MAX_SEQ,
    load_in_4bit=True,
)

model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    lora_alpha=16,
    lora_dropout=0,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth",
    random_state=42,
)

tokenizer = get_chat_template(tokenizer, chat_template="qwen-2.5")

def format_row(row):
    return {
        "text": tokenizer.apply_chat_template(
            row["messages"], tokenize=False, add_generation_prompt=False
        )
    }

train_ds = load_dataset("json", data_files="train.jsonl", split="train").map(format_row)
val_ds = load_dataset("json", data_files="val.jsonl", split="train").map(format_row)

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=train_ds,
    eval_dataset=val_ds,
    args=SFTConfig(
        dataset_text_field="text",
        max_seq_length=MAX_SEQ,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        num_train_epochs=3,
        learning_rate=2e-4,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        logging_steps=5,
        eval_strategy="epoch",
        save_strategy="epoch",
        output_dir="outputs",
        seed=42,
        report_to="none",
    ),
)

trainer.train()

# Export merged GGUF for Ollama on Apple Silicon.
model.save_pretrained_gguf("gguf", tokenizer, quantization_method="q4_k_m")
print("GGUF written to gguf/ — download it and `ollama create` per finetune/README.md")
