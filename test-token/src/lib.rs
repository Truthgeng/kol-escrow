//! tUSDC: a free test token for the testnet demo. NEP-141 compatible, 6 decimals.
//! Anyone can mint up to 1,000 tUSDC per call. No storage registration needed
//! (storage_deposit exists and refunds, so wallets and apps that call it still work).
//! Testnet only. Never deploy to mainnet.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
};

const MAX_MINT: u128 = 1_000_000_000; // 1,000 tUSDC
const GAS_ON_TRANSFER: Gas = Gas::from_tgas(30);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);

#[near(serializers = [json])]
pub struct Metadata {
    spec: String,
    name: String,
    symbol: String,
    icon: Option<String>,
    reference: Option<String>,
    reference_hash: Option<String>,
    decimals: u8,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    total: U128,
    available: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Token {
    balances: LookupMap<AccountId, u128>,
    supply: u128,
}

#[near]
impl Token {
    #[init]
    pub fn new() -> Self {
        Self { balances: LookupMap::new(b"b"), supply: 0 }
    }

    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(amount.0 > 0 && amount.0 <= MAX_MINT, "Mint between 0 and 1,000 tUSDC");
        self.add(&account_id, amount.0);
        self.supply += amount.0;
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_mint\",\"data\":[{{\"owner_id\":\"{}\",\"amount\":\"{}\"}}]}}",
            account_id, amount.0
        ));
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires 1 yoctoNEAR");
        let _ = memo;
        self.move_tokens(&env::predecessor_account_id(), &receiver_id, amount.0);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "Requires 1 yoctoNEAR");
        let _ = memo;
        let sender = env::predecessor_account_id();
        self.move_tokens(&sender, &receiver_id, amount.0);
        Promise::new(receiver_id.clone())
            .function_call(
                "ft_on_transfer".to_string(),
                near_sdk::serde_json::json!({ "sender_id": sender, "amount": amount, "msg": msg })
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_ON_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
    }

    /// Returns the amount actually used by the receiver. Unused tokens go back to the sender.
    #[private]
    pub fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let unused = match env::promise_result_checked(0, 64) {
            Ok(v) => near_sdk::serde_json::from_slice::<U128>(&v)
                .map(|u| u.0.min(amount.0))
                .unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        if unused > 0 {
            let back = unused.min(self.balance(&receiver_id));
            if back > 0 {
                self.move_tokens(&receiver_id, &sender_id, back);
            }
            return U128(amount.0 - back);
        }
        amount
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balance(&account_id))
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.supply)
    }

    pub fn ft_metadata(&self) -> Metadata {
        Metadata {
            spec: "ft-1.0.0".into(),
            name: "Test USDC (KOL Escrow demo)".into(),
            symbol: "tUSDC".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }

    /// Compatibility only: storage is free here, so any deposit is refunded.
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = (account_id, registration_only);
        let dep = env::attached_deposit();
        if !dep.is_zero() {
            Promise::new(env::predecessor_account_id()).transfer(dep).detach();
        }
        StorageBalance { total: U128(0), available: U128(0) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        let _ = account_id;
        Some(StorageBalance { total: U128(0), available: U128(0) })
    }
}

impl Token {
    fn balance(&self, a: &AccountId) -> u128 {
        self.balances.get(a).copied().unwrap_or(0)
    }
    fn add(&mut self, a: &AccountId, v: u128) {
        let b = self.balance(a);
        self.balances.insert(a.clone(), b + v);
    }
    fn move_tokens(&mut self, from: &AccountId, to: &AccountId, v: u128) {
        require!(v > 0, "Amount must be above zero");
        require!(from != to, "Sender and receiver are the same");
        let b = self.balance(from);
        require!(b >= v, "Not enough balance");
        self.balances.insert(from.clone(), b - v);
        self.add(to, v);
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_transfer\",\"data\":[{{\"old_owner_id\":\"{}\",\"new_owner_id\":\"{}\",\"amount\":\"{}\"}}]}}",
            from, to, v
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(pred: &str, dep: u128) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(pred.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(dep))
            .build());
    }

    #[test]
    fn mint_and_transfer() {
        ctx("a.near", 0);
        let mut t = Token::new();
        t.mint("a.near".parse().unwrap(), U128(500));
        ctx("a.near", 1);
        t.ft_transfer("b.near".parse().unwrap(), U128(200), None);
        assert_eq!(t.ft_balance_of("a.near".parse().unwrap()).0, 300);
        assert_eq!(t.ft_balance_of("b.near".parse().unwrap()).0, 200);
        assert_eq!(t.ft_total_supply().0, 500);
    }

    #[test]
    #[should_panic(expected = "Not enough balance")]
    fn no_overdraft() {
        ctx("a.near", 1);
        let mut t = Token::new();
        t.ft_transfer("b.near".parse().unwrap(), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "Mint between")]
    fn mint_cap() {
        ctx("a.near", 0);
        let mut t = Token::new();
        t.mint("a.near".parse().unwrap(), U128(MAX_MINT + 1));
    }
}
