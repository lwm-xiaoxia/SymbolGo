import styles from './Card.module.scss';

export function Card() {
  return (
    <div className={styles.card}>
      <span className={styles.card__title}>标题</span>
    </div>
  );
}
